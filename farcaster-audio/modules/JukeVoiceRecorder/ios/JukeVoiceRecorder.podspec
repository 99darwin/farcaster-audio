require 'json'

Pod::Spec.new do |s|
  s.name           = 'JukeVoiceRecorder'
  s.version        = '0.1.0'
  s.summary        = 'Voice note recording module for Juke'
  s.description    = 'Expo module for recording, trimming, and extracting peaks from voice notes'
  s.author         = ''
  s.homepage       = 'https://juke.audio'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '*.swift'
end
