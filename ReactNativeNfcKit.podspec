require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ReactNativeNfcKit'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = package['author']
  s.homepage       = package['homepage']
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/visibait/react-native-nfc-kit.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # CoreNFC ships on every device running the deployment target, so it is linked
  # normally. The previous generation of this library weak-linked it, which was
  # necessary when it supported iOS 8; it is not any more, and availability is a
  # runtime question answered by NFCReaderSession.readingAvailable -- an iPad has
  # the framework and no radio.
  s.frameworks = 'CoreNFC'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES'
  }

  s.source_files = 'ios/**/*.{h,m,mm,swift,hpp,cpp}'
end
