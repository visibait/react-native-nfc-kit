package com.nfckit.tech

import android.nfc.Tag
import android.nfc.tech.IsoDep
import android.nfc.tech.MifareClassic
import android.nfc.tech.MifareUltralight
import android.nfc.tech.Ndef
import android.nfc.tech.NdefFormatable
import android.nfc.tech.NfcA
import android.nfc.tech.NfcB
import android.nfc.tech.NfcBarcode
import android.nfc.tech.NfcF
import android.nfc.tech.NfcV
import android.nfc.tech.TagTechnology
import com.nfckit.NfcErrorCode
import com.nfckit.NfcException

/**
 * One technology's operations, behind a uniform interface.
 *
 * `android.nfc.tech.TagTechnology` is nearly empty -- it has `connect`, `close`
 * and `isConnected`, and nothing else. Everything useful lives on the concrete
 * subclasses, and none of them share an interface, so calling `transceive` means
 * downcasting first.
 *
 * The library this replaces did that downcast inline in four separate
 * `switch (tech)` ladders, one each for `transceive`, `getMaxTransceiveLength`,
 * `setTimeout` and `getTimeout` -- around 260 lines that are the same shape four
 * times over, and four places to forget a technology when adding one. Here each
 * technology is described once, and adding one is a single entry in
 * [TechRegistry].
 */
internal interface TechAdapter {
  /** The wire name shared with TypeScript. */
  val tech: String

  /** Fully-qualified `android.nfc.tech` class name, as it appears in a tech list. */
  val androidTechName: String

  fun create(tag: Tag): TagTechnology

  fun transceive(handle: TagTechnology, data: ByteArray): ByteArray

  fun maxTransceiveLength(handle: TagTechnology): Int

  fun setTimeout(handle: TagTechnology, timeoutMs: Int)

  fun getTimeout(handle: TagTechnology): Int
}

/**
 * A technology described by what it can do, rather than by a branch in a switch.
 *
 * An operation with no lambda is one the platform genuinely does not offer for
 * that technology -- `NfcV` has no timeout control, `Ndef` has no raw exchange --
 * and calling it produces an error naming the technology and the operation, which
 * is far more useful than a `ClassCastException` from a missed switch case.
 */
internal class TechDescription(
  override val tech: String,
  override val androidTechName: String,
  private val factory: (Tag) -> TagTechnology,
  private val transceiveFn: ((TagTechnology, ByteArray) -> ByteArray)? = null,
  private val maxTransceiveLengthFn: ((TagTechnology) -> Int)? = null,
  private val setTimeoutFn: ((TagTechnology, Int) -> Unit)? = null,
  private val getTimeoutFn: ((TagTechnology) -> Int)? = null,
) : TechAdapter {

  override fun create(tag: Tag): TagTechnology = factory(tag)

  override fun transceive(handle: TagTechnology, data: ByteArray): ByteArray =
    requireSupported(transceiveFn, "transceive")(handle, data)

  override fun maxTransceiveLength(handle: TagTechnology): Int =
    requireSupported(maxTransceiveLengthFn, "maxTransceiveLength")(handle)

  override fun setTimeout(handle: TagTechnology, timeoutMs: Int) =
    requireSupported(setTimeoutFn, "setTechTimeout")(handle, timeoutMs)

  override fun getTimeout(handle: TagTechnology): Int =
    requireSupported(getTimeoutFn, "getTechTimeout")(handle)

  private fun <T : Any> requireSupported(operation: T?, name: String): T =
    operation
      ?: throw NfcException(
        NfcErrorCode.TECH_UNAVAILABLE,
        "Android does not offer \"$name\" for the \"$tech\" technology.",
      )
}

/**
 * Every technology this library can reach on Android.
 *
 * Ordering is irrelevant here; [com.nfckit.reader.TagHandle] decides which one a
 * bare `transceive` uses. Adding support for a technology means adding one entry.
 */
internal object TechRegistry {
  private val adapters: List<TechAdapter> = listOf(
    TechDescription(
      tech = "ndef",
      androidTechName = Ndef::class.java.name,
      factory = { Ndef.get(it) },
      maxTransceiveLengthFn = { (it as Ndef).maxSize },
    ),
    TechDescription(
      tech = "ndefFormatable",
      androidTechName = NdefFormatable::class.java.name,
      factory = { NdefFormatable.get(it) },
    ),
    TechDescription(
      tech = "isoDep",
      androidTechName = IsoDep::class.java.name,
      factory = { IsoDep.get(it) },
      transceiveFn = { handle, data -> (handle as IsoDep).transceive(data) },
      maxTransceiveLengthFn = { (it as IsoDep).maxTransceiveLength },
      setTimeoutFn = { handle, timeout -> (handle as IsoDep).timeout = timeout },
      getTimeoutFn = { (it as IsoDep).timeout },
    ),
    TechDescription(
      tech = "nfcA",
      androidTechName = NfcA::class.java.name,
      factory = { NfcA.get(it) },
      transceiveFn = { handle, data -> (handle as NfcA).transceive(data) },
      maxTransceiveLengthFn = { (it as NfcA).maxTransceiveLength },
      setTimeoutFn = { handle, timeout -> (handle as NfcA).timeout = timeout },
      getTimeoutFn = { (it as NfcA).timeout },
    ),
    TechDescription(
      tech = "nfcB",
      androidTechName = NfcB::class.java.name,
      factory = { NfcB.get(it) },
      transceiveFn = { handle, data -> (handle as NfcB).transceive(data) },
      maxTransceiveLengthFn = { (it as NfcB).maxTransceiveLength },
      // NfcB exposes no timeout control at all.
    ),
    TechDescription(
      tech = "felica",
      androidTechName = NfcF::class.java.name,
      factory = { NfcF.get(it) },
      transceiveFn = { handle, data -> (handle as NfcF).transceive(data) },
      maxTransceiveLengthFn = { (it as NfcF).maxTransceiveLength },
      setTimeoutFn = { handle, timeout -> (handle as NfcF).timeout = timeout },
      getTimeoutFn = { (it as NfcF).timeout },
    ),
    TechDescription(
      tech = "iso15693",
      androidTechName = NfcV::class.java.name,
      factory = { NfcV.get(it) },
      transceiveFn = { handle, data -> (handle as NfcV).transceive(data) },
      maxTransceiveLengthFn = { (it as NfcV).maxTransceiveLength },
      // NfcV exposes no timeout control.
    ),
    TechDescription(
      tech = "mifareClassic",
      androidTechName = MifareClassic::class.java.name,
      factory = { MifareClassic.get(it) },
      transceiveFn = { handle, data -> (handle as MifareClassic).transceive(data) },
      maxTransceiveLengthFn = { (it as MifareClassic).maxTransceiveLength },
      setTimeoutFn = { handle, timeout -> (handle as MifareClassic).timeout = timeout },
      getTimeoutFn = { (it as MifareClassic).timeout },
    ),
    TechDescription(
      tech = "mifareUltralight",
      androidTechName = MifareUltralight::class.java.name,
      factory = { MifareUltralight.get(it) },
      transceiveFn = { handle, data -> (handle as MifareUltralight).transceive(data) },
      maxTransceiveLengthFn = { (it as MifareUltralight).maxTransceiveLength },
      setTimeoutFn = { handle, timeout -> (handle as MifareUltralight).timeout = timeout },
      getTimeoutFn = { (it as MifareUltralight).timeout },
    ),
    TechDescription(
      tech = "nfcBarcode",
      androidTechName = NfcBarcode::class.java.name,
      factory = { NfcBarcode.get(it) },
    ),
  )

  private val byTech: Map<String, TechAdapter> = adapters.associateBy { it.tech }

  /** Every technology name this build knows about. */
  val allTechNames: List<String> = adapters.map { it.tech }

  fun adapterFor(tech: String): TechAdapter =
    byTech[tech]
      ?: throw NfcException(
        NfcErrorCode.TECH_UNAVAILABLE,
        "Unknown technology \"$tech\". Known technologies: ${allTechNames.joinToString(", ")}.",
      )

  /**
   * The technologies a specific tag actually supports.
   *
   * Gated on the tag's own tech list rather than on the API level, because
   * MIFARE Classic and MIFARE Ultralight are chipset-dependent: some NFC
   * controllers have never implemented Crypto-1 at all. The library this replaces
   * answered that question by probing `/dev/bcm2079x-i2c` and `/dev/pn544`,
   * scanning `/system/lib` for vendor libraries, and special-casing one Lenovo
   * model by name. The tag knows; ask the tag.
   */
  fun techsFor(tag: Tag): List<String> {
    val available = tag.techList.toSet()
    return adapters.filter { available.contains(it.androidTechName) }.map { it.tech }
  }
}
