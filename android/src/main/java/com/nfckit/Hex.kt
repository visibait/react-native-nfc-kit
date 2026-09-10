package com.nfckit

/**
 * Hex helpers.
 *
 * Small identifiers -- a UID, historical bytes -- travel to JavaScript as
 * lowercase hex rather than as byte arrays, because events cannot reliably carry
 * a `ByteArray` on Android: it arrives as an opaque string id instead of a
 * `Uint8Array` (expo/expo#29566). Bulk binary always comes back from a function
 * return, where the conversion is well-trodden.
 */
internal object Hex {
  private val DIGITS = "0123456789abcdef".toCharArray()

  fun encode(bytes: ByteArray?): String? {
    if (bytes == null) {
      return null
    }
    val out = CharArray(bytes.size * 2)
    for (i in bytes.indices) {
      val value = bytes[i].toInt() and 0xff
      out[i * 2] = DIGITS[value ushr 4]
      out[i * 2 + 1] = DIGITS[value and 0x0f]
    }
    return String(out)
  }
}
