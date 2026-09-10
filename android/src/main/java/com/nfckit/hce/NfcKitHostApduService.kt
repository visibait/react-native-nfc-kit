package com.nfckit.hce

import android.nfc.cardemulation.HostApduService
import android.os.Bundle

/**
 * The service Android binds when a terminal selects one of the app's AIDs.
 *
 * Declared in the app's manifest by the config plugin, not by this library, so an
 * app that does not emulate a card never registers an HCE service at all. The
 * class ships either way; only the declaration is conditional.
 *
 * Everything it does is forwarded to [HceBridge], which is the only thing that can
 * be reached from both here and the module: the platform starts this service
 * without reference to any Activity, and there is no guarantee a React Native
 * context exists at the moment it does.
 */
class NfcKitHostApduService : HostApduService() {

  /**
   * Called for each command APDU while a terminal is talking to the app.
   *
   * Returning `null` means "the answer is coming later, via `sendResponseApdu`",
   * which is the only shape a round trip to JavaScript can fit into. The platform
   * keeps the RF link open in the meantime.
   */
  override fun processCommandApdu(commandApdu: ByteArray?, extras: Bundle?): ByteArray? {
    val command = commandApdu ?: return NO_COMMAND_RESPONSE
    return HceBridge.dispatch(command) { response -> sendResponseApdu(response) }
  }

  /**
   * Called when the link ends, either because the terminal selected a different
   * application or because the field was lost.
   *
   * Both matter to an app: the first means "someone else's turn", the second means
   * "the phone was moved away", and a card that keeps its selection state across
   * either would answer the next terminal as though it had already been through
   * the handshake.
   */
  override fun onDeactivated(reason: Int) {
    HceBridge.deactivated(reason)
  }

  private companion object {
    /**
     * `6F00` for a command that arrived with no bytes.
     *
     * Should not happen, and the platform's own documentation allows for it, so
     * answering beats returning null and leaving the terminal waiting for a
     * response nothing will ever send.
     */
    val NO_COMMAND_RESPONSE = byteArrayOf(0x6F, 0x00)
  }
}
