package com.nfckit.reader

import android.app.Activity
import android.nfc.NfcAdapter
import android.os.Bundle
import android.os.DeadObjectException
import com.nfckit.NfcErrorCode
import com.nfckit.NfcException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.asCoroutineDispatcher
import java.util.concurrent.Executors

/**
 * The one thread all tag I/O runs on.
 *
 * A dedicated single thread rather than `Dispatchers.IO`, for two reasons that
 * both bite in practice: `IsoDep` and `MifareClassic` handles are not
 * thread-safe, and `Dispatchers.IO` is a pool with no ordering guarantee, so two
 * exchanges could interleave on one connection. A blocked `transceive` is also
 * cancelled with an `IOException` if `close()` runs on another thread, which a
 * pool makes easy to do by accident.
 *
 * The library this replaces ran blocking radio I/O on React Native's own native
 * modules thread while holding a module-wide monitor, so one slow tag blocked
 * every other call into the module.
 */
internal object TagIo {
  private val executor = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "nfc-kit-tag-io").apply { isDaemon = true }
  }

  val dispatcher: CoroutineDispatcher = executor.asCoroutineDispatcher()
}

/** Reader-mode tuning, as the caller asked for it. */
internal data class ReaderOptions(
  val skipNdefCheck: Boolean,
  val noPlatformSounds: Boolean,
  val presenceCheckDelayMs: Int?,
)

/**
 * Owns reader mode.
 *
 * Reader mode, not foreground dispatch. Foreground dispatch delivers tags as
 * Intents, which means `onPause`/`onResume` churn and the well-known loop where
 * disabling dispatch in `onPause` re-triggers discovery. Reader mode gives the
 * foreground activity exclusive access to the controller, pauses the system's own
 * payment polling, lets the app name exactly which RF technologies to acknowledge,
 * and delivers callbacks off the intent system entirely.
 *
 * The library this replaces kept both paths and switched between them on a
 * boolean, and they emitted different event sequences for identical user code.
 */
internal class ReaderModeController(private val adapterProvider: () -> NfcAdapter?) {

  private var enabledFor: Activity? = null

  /** Whether reader mode is currently meant to be on, across foreground changes. */
  var wanted: Boolean = false
    private set

  private var techs: List<String> = emptyList()
  private var options: ReaderOptions =
    ReaderOptions(skipNdefCheck = false, noPlatformSounds = false, presenceCheckDelayMs = null)
  private var callback: NfcAdapter.ReaderCallback? = null

  fun requireAdapter(): NfcAdapter =
    adapterProvider()
      ?: throw NfcException(
        NfcErrorCode.NFC_UNSUPPORTED,
        "This device has no NFC adapter.",
      )

  fun want(
    activity: Activity,
    techs: List<String>,
    options: ReaderOptions,
    callback: NfcAdapter.ReaderCallback,
  ) {
    this.techs = techs
    this.options = options
    this.callback = callback
    this.wanted = true
    enable(activity)
  }

  fun unwant(activity: Activity?) {
    wanted = false
    callback = null
    disable(activity)
  }

  /** Re-enables after the activity comes back, if reader mode is still wanted. */
  fun resumeIfWanted(activity: Activity) {
    if (wanted && callback != null) {
      enable(activity)
    }
  }

  /** Drops reader mode while the activity is in the background, keeping intent. */
  fun suspend(activity: Activity?) {
    disable(activity)
  }

  private fun enable(activity: Activity) {
    val adapter = requireAdapter()
    val readerCallback = callback ?: return

    val extras = Bundle().apply {
      options.presenceCheckDelayMs?.let {
        putInt(NfcAdapter.EXTRA_READER_PRESENCE_CHECK_DELAY, it)
      }
    }

    withBinderRetry("enable reader mode") {
      adapter.enableReaderMode(activity, readerCallback, flagsFor(techs, options), extras)
    }
    enabledFor = activity
  }

  private fun disable(activity: Activity?) {
    val target = activity ?: enabledFor ?: return
    val adapter = adapterProvider() ?: return

    try {
      withBinderRetry("disable reader mode") { adapter.disableReaderMode(target) }
    } catch (_: NfcException) {
      // Tearing down is best effort. The activity may already be finishing, and
      // failing to disable must never stop a session from being cleaned up.
    }
    enabledFor = null
  }

  /**
   * Retries once when the NFC service's binder has died.
   *
   * `DeadObjectException` out of `setReaderMode` has been reported on Android 16:
   * the NFC service restarts and the cached binder goes stale. Re-fetching the
   * adapter and trying again recovers it; failing twice is a real problem and is
   * reported as one rather than swallowed.
   */
  private inline fun withBinderRetry(what: String, block: () -> Unit) {
    try {
      block()
    } catch (first: RuntimeException) {
      if (!isDeadBinder(first)) {
        throw NfcException.from(NfcErrorCode.INTERNAL_ERROR, "Could not $what.", first)
      }
      try {
        block()
      } catch (second: RuntimeException) {
        throw NfcException.from(
          NfcErrorCode.INTERNAL_ERROR,
          "Could not $what: the NFC service is not responding. Switching NFC off and on again " +
            "usually recovers it.",
          second,
        )
      }
    }
  }

  companion object {
    fun isDeadBinder(error: Throwable?): Boolean {
      var current = error
      var depth = 0
      while (current != null && depth < 8) {
        if (current is DeadObjectException) {
          return true
        }
        current = current.cause
        depth += 1
      }
      return false
    }

    /**
     * Turns requested technologies into reader-mode flags.
     *
     * A technology maps to the RF technologies that can carry it. NDEF is not an
     * RF technology at all -- it is a data format that can sit on any of them --
     * so asking for NDEF polls everything.
     */
    fun flagsFor(techs: List<String>, options: ReaderOptions): Int {
      var flags = 0

      for (tech in techs) {
        flags = flags or when (tech) {
          "ndef", "ndefFormatable" ->
            NfcAdapter.FLAG_READER_NFC_A or
              NfcAdapter.FLAG_READER_NFC_B or
              NfcAdapter.FLAG_READER_NFC_F or
              NfcAdapter.FLAG_READER_NFC_V
          // ISO-DEP runs over either NFC-A or NFC-B framing.
          "isoDep" -> NfcAdapter.FLAG_READER_NFC_A or NfcAdapter.FLAG_READER_NFC_B
          "nfcA", "mifareClassic", "mifareUltralight" -> NfcAdapter.FLAG_READER_NFC_A
          "nfcB" -> NfcAdapter.FLAG_READER_NFC_B
          "felica" -> NfcAdapter.FLAG_READER_NFC_F
          "iso15693" -> NfcAdapter.FLAG_READER_NFC_V
          "nfcBarcode" -> NfcAdapter.FLAG_READER_NFC_BARCODE
          else -> 0
        }
      }

      if (options.skipNdefCheck) {
        flags = flags or NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK
      }
      if (options.noPlatformSounds) {
        flags = flags or NfcAdapter.FLAG_READER_NO_PLATFORM_SOUNDS
      }

      return flags
    }
  }
}
