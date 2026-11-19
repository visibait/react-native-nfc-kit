package com.nfckit.background

import android.app.Activity
import android.app.ActivityOptions
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.nfc.NfcAdapter
import android.os.Build
import android.os.Bundle
import org.xmlpull.v1.XmlPullParser

/**
 * Claims the app's background tags for itself while it is in the foreground.
 *
 * An app that declares a `TECH_DISCOVERED` filter (`backgroundReading.techLists`)
 * gets those tags delivered when no reader session is open — but only if it is
 * the one app that declared them. With two apps on the device asking for the
 * same technology, Android shows its own "choose an app" screen instead, over
 * the app that is in front, for a tag the user meant for it. That happens on
 * any terminal running more than one app built with this library, and it is
 * indistinguishable, to the person holding the phone, from the reader having
 * stopped working.
 *
 * Foreground dispatch for exactly the declared tech lists closes that gap: the
 * activity in front is preferred over every manifest filter, so the tag comes
 * back to it through `onNewIntent`, the same path a background tag takes. It
 * does not compete with reader mode, which takes precedence whenever a session
 * is open; this only covers the moments with no session, such as between two
 * screens or while JavaScript reloads.
 *
 * Nothing is claimed unless the app declared background reading: claiming tags
 * the app never asked for would make it swallow other apps' tags while open.
 *
 * Android removes foreground dispatch by itself when the activity pauses, so
 * it is set again on every resume and never removed by hand: the module's
 * "background" event also fires while JavaScript reloads, with the activity
 * still on screen, which is precisely when the safety net is needed. Calls must happen on the main thread with the activity
 * resumed; anything else is ignored rather than thrown, because this is a safety
 * net and must never break the session it backs up.
 */
internal class ForegroundDispatch(private val adapterProvider: () -> NfcAdapter?) {

  private var declared: Array<Array<String>>? = null
  private var loaded = false

  fun enable(activity: Activity) {
    val techLists = declaredTechLists(activity) ?: return
    val adapter = adapterProvider() ?: return

    val intent = Intent(activity, activity.javaClass).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
    // Mutable: the NFC service fills in the tag extras when it fires it.
    // Cancel-current, not update-current: updating keeps the existing record
    // and only swaps its extras, so creator options set here (the start-mode
    // opt-in below) never reach one created before them, for example by a
    // previous version of the app.
    val flags = PendingIntent.FLAG_CANCEL_CURRENT or
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
    val pending =
      PendingIntent.getActivity(activity, REQUEST_CODE, intent, flags, creatorOptions())

    try {
      adapter.enableForegroundDispatch(
        activity,
        pending,
        arrayOf(IntentFilter(NfcAdapter.ACTION_TECH_DISCOVERED)),
        techLists,
      )
    } catch (_: RuntimeException) {
      // Not resumed yet, or the NFC service is restarting: the next resume
      // sets it again.
    }
  }

  /**
   * Lets the NFC service bring the tag to this activity.
   *
   * From Android 15 an app targeting it has to opt in, as the creator of the
   * pending intent, to the activity start it causes; without it the system
   * logs "Background activity launch blocked" for every tag. It still reached
   * the activity in testing because the activity was already on top, but that
   * is the system being lenient, not a guarantee. Opting in "if visible" is the
   * narrowest grant: it only applies while the app has a window on screen,
   * which is the only time foreground dispatch is set at all.
   */
  private fun creatorOptions(): Bundle? =
    when {
      Build.VERSION.SDK_INT >= 36 ->
        ActivityOptions.makeBasic()
          .setPendingIntentCreatorBackgroundActivityStartMode(
            ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOW_IF_VISIBLE,
          )
          .toBundle()
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE ->
        @Suppress("DEPRECATION")
        ActivityOptions.makeBasic()
          .setPendingIntentCreatorBackgroundActivityStartMode(
            ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED,
          )
          .toBundle()
      else -> null
    }

  /**
   * The tech lists from `res/xml/nfc_kit_tech_filter.xml`, the same file the
   * manifest filter points at, so the two can never disagree. Read once.
   */
  @Synchronized
  private fun declaredTechLists(context: Context): Array<Array<String>>? {
    if (loaded) return declared
    loaded = true
    declared = try {
      readTechFilter(context)
    } catch (_: Exception) {
      null
    }
    return declared
  }

  private fun readTechFilter(context: Context): Array<Array<String>>? {
    @Suppress("DiscouragedApi")
    val id = context.resources.getIdentifier(TECH_FILTER_RESOURCE, "xml", context.packageName)
    if (id == 0) return null

    val lists = mutableListOf<Array<String>>()
    var current: MutableList<String>? = null
    context.resources.getXml(id).use { parser ->
      var event = parser.eventType
      while (event != XmlPullParser.END_DOCUMENT) {
        when (event) {
          XmlPullParser.START_TAG -> when (parser.name) {
            "tech-list" -> current = mutableListOf()
            "tech" -> parser.nextText().trim().takeIf { it.isNotEmpty() }?.let { current?.add(it) }
          }
          XmlPullParser.END_TAG -> if (parser.name == "tech-list") {
            current?.takeIf { it.isNotEmpty() }?.let { lists.add(it.toTypedArray()) }
            current = null
          }
        }
        event = parser.next()
      }
    }
    return lists.takeIf { it.isNotEmpty() }?.toTypedArray()
  }

  private companion object {
    const val TECH_FILTER_RESOURCE = "nfc_kit_tech_filter"
    const val REQUEST_CODE = 0x4e46
  }
}
