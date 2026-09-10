package com.nfckit.hce

import android.nfc.cardemulation.PollingFrame
import androidx.annotation.RequiresApi
import com.nfckit.Hex

/**
 * The polling loop, as an app can see it from Android 15 (API 35).
 *
 * Before a reader selects anything it polls: it energises the field and sends
 * technology-specific frames looking for a card. Those frames are what this
 * exposes, and they arrive before any AID selection — which is the whole point.
 * An app can tell a reader is present, and often which kind, while it still has
 * the option not to answer.
 *
 * That is what makes observe mode useful rather than merely possible: hold the
 * card silent, notice the reader from its polling, ask the user, and only then
 * answer.
 */
@RequiresApi(35)
internal object PollingFrames {

  /**
   * Frame types as names rather than integers.
   *
   * `on` and `off` are the field itself appearing and disappearing, not a
   * technology, which is why they cannot be folded into the same list as A/B/F
   * without losing what they mean.
   */
  fun typeName(type: Int): String =
    when (type) {
      PollingFrame.POLLING_LOOP_TYPE_A -> "a"
      PollingFrame.POLLING_LOOP_TYPE_B -> "b"
      PollingFrame.POLLING_LOOP_TYPE_F -> "f"
      PollingFrame.POLLING_LOOP_TYPE_ON -> "on"
      PollingFrame.POLLING_LOOP_TYPE_OFF -> "off"
      else -> "unknown"
    }

  fun toMap(frame: PollingFrame): Map<String, Any?> =
    mapOf(
      "type" to typeName(frame.type),
      // Hex rather than bytes: a polling frame is a handful of bytes, and the
      // rule that events carry no `ByteArray` holds here as everywhere else.
      "dataHex" to Hex.encode(frame.data),
      // Vendor-specific and not comparable across devices; -1 when the
      // controller does not report it.
      "gain" to frame.vendorSpecificGain,
      // The platform's own monotonic value. Useful for ordering frames and
      // measuring the gap between them, and for nothing else.
      "timestamp" to frame.timestamp,
      "triggeredAutoTransact" to frame.triggeredAutoTransact,
    )
}
