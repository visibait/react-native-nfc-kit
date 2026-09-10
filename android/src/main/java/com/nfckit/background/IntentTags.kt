package com.nfckit.background

import android.content.Intent
import android.nfc.NdefMessage
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.os.Build

/**
 * A tag pulled out of an intent, with whatever the system already read from it.
 */
internal class DispatchedTag(
  val tag: Tag,
  /** The first NDEF message the system read, when the intent carried one. */
  val ndefMessage: ByteArray?,
)

/**
 * Reads a tag out of an NFC intent.
 *
 * Only the two actions this library declares are accepted. `ACTION_TAG_DISCOVERED`
 * is not among them: it is deprecated as of API 37, and it is also the widest
 * possible filter — it fires for any tag at all, which is how an app ends up
 * being launched by a colleague's building pass.
 */
internal object IntentTags {

  private val ACCEPTED_ACTIONS = setOf(
    NfcAdapter.ACTION_NDEF_DISCOVERED,
    NfcAdapter.ACTION_TECH_DISCOVERED,
  )

  fun isNfcIntent(intent: Intent?): Boolean = intent?.action in ACCEPTED_ACTIONS

  /**
   * Extracts the tag, and removes it from the intent.
   *
   * Removing it matters more than it looks. An activity's launch intent outlives
   * the activity: rotate the screen, or come back from the recents list, and the
   * same intent is handed to the recreated activity — so an app that reads it
   * without consuming it processes the same tap again, minutes later, with the
   * card long gone. Clearing the extra is what makes "the tag that launched the
   * app" mean it exactly once.
   */
  fun take(intent: Intent?): DispatchedTag? {
    if (!isNfcIntent(intent) || intent == null) {
      return null
    }

    val tag = tagExtra(intent) ?: return null
    val message = ndefExtra(intent)

    intent.removeExtra(NfcAdapter.EXTRA_TAG)
    intent.removeExtra(NfcAdapter.EXTRA_NDEF_MESSAGES)

    return DispatchedTag(tag, message)
  }

  @Suppress("DEPRECATION")
  private fun tagExtra(intent: Intent): Tag? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      intent.getParcelableExtra(NfcAdapter.EXTRA_TAG, Tag::class.java)
    } else {
      intent.getParcelableExtra(NfcAdapter.EXTRA_TAG) as Tag?
    }

  /**
   * The first NDEF message the system read before dispatching.
   *
   * `EXTRA_NDEF_MESSAGES` is only populated for `ACTION_NDEF_DISCOVERED`, and it
   * is the only reliable way to see a background tag's content: by the time the
   * app is running, the card is usually no longer in the field.
   */
  @Suppress("DEPRECATION")
  private fun ndefExtra(intent: Intent): ByteArray? {
    val raw =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        intent.getParcelableArrayExtra(NfcAdapter.EXTRA_NDEF_MESSAGES, NdefMessage::class.java)
      } else {
        intent.getParcelableArrayExtra(NfcAdapter.EXTRA_NDEF_MESSAGES)
          ?.filterIsInstance<NdefMessage>()
          ?.toTypedArray()
      }

    return raw?.firstOrNull()?.toByteArray()
  }
}
