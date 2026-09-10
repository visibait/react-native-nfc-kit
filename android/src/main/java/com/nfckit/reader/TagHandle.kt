package com.nfckit.reader

import android.nfc.FormatException
import android.nfc.NdefMessage
import android.nfc.Tag
import android.nfc.TagLostException
import android.nfc.tech.Ndef
import android.nfc.tech.NdefFormatable
import android.nfc.tech.TagTechnology
import com.nfckit.Hex
import com.nfckit.NfcErrorCode
import com.nfckit.NfcException
import com.nfckit.tech.TechRegistry
import java.io.IOException

/**
 * A discovered tag, and whatever technology is currently connected to it.
 *
 * Android permits exactly one connected `TagTechnology` per tag at a time, so this
 * connects lazily and closes the previous one when a different technology is
 * needed. Callers never connect explicitly; they ask for an operation and the
 * right connection is arranged underneath.
 *
 * **Threading:** every method here blocks on radio I/O and must be called on the
 * dedicated tag-I/O thread. `IsoDep` and `MifareClassic` handles are not
 * thread-safe, and a blocked `transceive` is cancelled with an `IOException` if
 * `close()` runs on another thread. [TagIo] is the only correct caller.
 */
internal class TagHandle(
  val id: String,
  private val tag: Tag,
  /**
   * The NDEF message the system already read, when this tag arrived in an intent.
   *
   * A background tag is usually gone by the time JavaScript gets to look at it:
   * the system read it, dispatched the intent, and the user has already taken
   * their card away. The message travelled with the intent, so it is still
   * available even though the radio is not, and [readNdef] falls back to it.
   */
  private val dispatchedNdef: ByteArray? = null,
) {
  private var connectedTech: String? = null
  private var connection: TagTechnology? = null

  @Volatile
  private var closed = false

  /** Technologies this specific tag supports, as reported by the tag itself. */
  val techs: List<String> = TechRegistry.techsFor(tag)

  val idHex: String? = Hex.encode(tag.id)

  /** Raw `Tag.getTechList()` entries, worth having in a bug report. */
  val androidTechList: List<String> = tag.techList.toList()

  /* ---------------------------------------------------------------------- */
  /* Connection                                                             */
  /* ---------------------------------------------------------------------- */

  private fun requireTech(tech: String) {
    if (!techs.contains(tech)) {
      throw NfcException(
        NfcErrorCode.TECH_UNAVAILABLE,
        "This tag does not support the \"$tech\" technology. " +
          "It supports: ${if (techs.isEmpty()) "none" else techs.joinToString(", ")}.",
      )
    }
  }

  /**
   * Runs `block` with `tech` connected.
   *
   * Reconnecting only happens when the technology actually changes, so a run of
   * ISO-DEP exchanges keeps one connection open rather than tearing it down and
   * re-establishing it -- which on a real card means re-doing the RF activation
   * sequence for every single APDU.
   */
  fun <T> withTech(tech: String, block: (TagTechnology) -> T): T {
    requireTech(tech)
    val adapter = TechRegistry.adapterFor(tech)

    if (connectedTech != tech) {
      closeConnection()
      val handle = adapter.create(tag)
        ?: throw NfcException(
          NfcErrorCode.TECH_UNAVAILABLE,
          "The \"$tech\" technology is listed on this tag but the platform returned no handle for it.",
        )
      try {
        handle.connect()
      } catch (cause: TagLostException) {
        throw NfcException.from(NfcErrorCode.TAG_LOST, "The tag left the field while connecting.", cause)
      } catch (cause: IOException) {
        throw NfcException.from(
          NfcErrorCode.TAG_CONNECTION_FAILED,
          "Could not connect to the tag over \"$tech\".",
          cause,
        )
      }
      connection = handle
      connectedTech = tech
    }

    val handle = connection
      ?: throw NfcException(NfcErrorCode.INTERNAL_ERROR, "No connection after connecting to \"$tech\".")

    return runMapping(tech) { block(handle) }
  }

  /** Maps the platform's exceptions onto codes, losing nothing on the way. */
  private fun <T> runMapping(what: String, block: () -> T): T =
    try {
      block()
    } catch (cause: NfcException) {
      throw cause
    } catch (cause: TagLostException) {
      // Its own branch before IOException, which it extends: "the tag moved" and
      // "the exchange failed" call for completely different handling.
      throw NfcException.from(NfcErrorCode.TAG_LOST, "The tag left the field during $what.", cause)
    } catch (cause: FormatException) {
      throw NfcException.from(NfcErrorCode.NDEF_MALFORMED, "The tag's NDEF data is malformed.", cause)
    } catch (cause: SecurityException) {
      throw NfcException.from(
        NfcErrorCode.NOT_AUTHORIZED,
        "The system refused the NFC operation. This usually means the tag was dispatched to " +
          "another app, or the activity is no longer in the foreground.",
        cause,
      )
    } catch (cause: IOException) {
      throw NfcException.from(NfcErrorCode.IO_ERROR, "The exchange with the tag failed during $what.", cause)
    } catch (cause: IllegalStateException) {
      throw NfcException.from(NfcErrorCode.IO_ERROR, "The tag was in an unusable state during $what.", cause)
    }

  private fun closeConnection() {
    try {
      connection?.close()
    } catch (_: IOException) {
      // A tag that has already gone throws on close. There is nothing to recover
      // and nothing the caller could do, and the operation that follows will
      // report the real problem.
    }
    connection = null
    connectedTech = null
  }

  fun close() {
    closed = true
    closeConnection()
  }

  /** Whether this handle is the tag the platform just told us about. */
  fun matchesTagId(other: ByteArray): Boolean = tag.id.contentEquals(other)

  /** Whether the tag is still in the field. Used by the removal poller. */
  fun isPresent(): Boolean =
    if (closed) false
    else try {
      connection?.isConnected ?: run {
        val probe = TechRegistry.adapterFor(techs.firstOrNull() ?: return false).create(tag)
        probe?.connect()
        val connected = probe?.isConnected == true
        probe?.close()
        connected
      }
    } catch (_: Throwable) {
      false
    }

  /* ---------------------------------------------------------------------- */
  /* Raw exchange                                                           */
  /* ---------------------------------------------------------------------- */

  fun transceive(tech: String, data: ByteArray): ByteArray =
    withTech(tech) { handle -> TechRegistry.adapterFor(tech).transceive(handle, data) }

  fun maxTransceiveLength(tech: String): Int =
    withTech(tech) { handle -> TechRegistry.adapterFor(tech).maxTransceiveLength(handle) }

  fun setTechTimeout(tech: String, timeoutMs: Int) {
    withTech(tech) { handle -> TechRegistry.adapterFor(tech).setTimeout(handle, timeoutMs) }
  }

  fun getTechTimeout(tech: String): Int =
    withTech(tech) { handle -> TechRegistry.adapterFor(tech).getTimeout(handle) }

  /* ---------------------------------------------------------------------- */
  /* NDEF                                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * The raw NDEF message bytes.
   *
   * Raw bytes rather than parsed records, so the decoding happens once, in
   * TypeScript, with the same implementation on both platforms. A tag with no
   * message yields an empty array, which decodes to an empty message -- that is
   * what a formatted but never-written tag genuinely contains, and reporting it
   * as a failure would make every blank tag look broken.
   */
  fun readNdef(): ByteArray =
    try {
      withTech("ndef") { handle ->
        val ndef = handle as Ndef
        ndef.ndefMessage?.toByteArray() ?: ByteArray(0)
      }
    } catch (cause: NfcException) {
      // Only ever non-null for a tag that arrived in an intent, so a session tag
      // still reports its failure. For a background tag, the message the system
      // already read is the better answer than an error about a card the user
      // put back in their pocket a second ago.
      dispatchedNdef ?: throw cause
    }

  fun writeNdef(bytes: ByteArray) {
    withTech("ndef") { handle ->
      val ndef = handle as Ndef

      if (!ndef.isWritable) {
        throw NfcException(
          NfcErrorCode.NDEF_READ_ONLY,
          "This tag is read-only, so its NDEF message cannot be replaced.",
        )
      }
      // Checked before writing: a tag that runs out of room part-way through is
      // left holding a partial message, which is worse than not writing at all.
      if (bytes.size > ndef.maxSize) {
        throw NfcException(
          NfcErrorCode.NDEF_CAPACITY_EXCEEDED,
          "The message is ${bytes.size} bytes but this tag holds at most ${ndef.maxSize}.",
        )
      }

      ndef.writeNdefMessage(NdefMessage(bytes))
    }
  }

  fun ndefStatus(): NdefStatusResult =
    withTech("ndef") { handle ->
      val ndef = handle as Ndef
      NdefStatusResult(
        writable = ndef.isWritable,
        capacity = ndef.maxSize,
        canMakeReadOnly = ndef.canMakeReadOnly(),
        typeName = ndef.type,
      )
    }

  fun makeNdefReadOnly() {
    withTech("ndef") { handle ->
      val ndef = handle as Ndef
      if (!ndef.canMakeReadOnly()) {
        throw NfcException(
          NfcErrorCode.NDEF_NOT_SUPPORTED,
          "This tag cannot be locked read-only. Check canMakeReadOnly in the NDEF status first.",
        )
      }
      if (!ndef.makeReadOnly()) {
        throw NfcException(NfcErrorCode.IO_ERROR, "The tag refused the lock operation.")
      }
    }
  }

  fun formatNdef(bytes: ByteArray) {
    withTech("ndefFormatable") { handle ->
      (handle as NdefFormatable).format(NdefMessage(bytes))
    }
  }
}

internal data class NdefStatusResult(
  val writable: Boolean,
  val capacity: Int,
  val canMakeReadOnly: Boolean,
  val typeName: String?,
)
