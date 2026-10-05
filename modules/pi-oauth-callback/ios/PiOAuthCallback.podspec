Pod::Spec.new do |s|
  s.name           = 'PiOAuthCallback'
  s.version        = '1.0.0'
  s.summary        = 'Loopback callback listener for Pi OAuth in Expo'
  s.description    = 'A bounded iOS loopback HTTP callback using Network.framework and Expo Modules 2.0.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4',
    :tvos => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.frameworks = 'Network'
  s.swift_version = '6.0'

  # Swift module integration
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "*.swift"
end
