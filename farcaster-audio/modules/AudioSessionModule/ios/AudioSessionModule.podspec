Pod::Spec.new do |s|
  s.name           = 'AudioSessionModule'
  s.version        = '0.1.0'
  s.summary        = 'Audio session management module for Juke'
  s.description    = 'Expo module for managing AVAudioSession configuration'
  s.author         = ''
  s.homepage       = 'https://juke.audio'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '*.swift'
end
