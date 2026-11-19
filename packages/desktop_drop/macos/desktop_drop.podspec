Pod::Spec.new do |s|
  s.name             = 'desktop_drop'
  s.version          = '0.8.4'
  s.summary          = 'macOS desktop drag and drop plugin for DreamFlutter.'
  s.description      = 'Allows dragging files and folders onto Flutter desktop windows on macOS.'
  s.homepage         = 'https://github.com/MixinNetwork/flutter-plugins'
  s.license          = { :file => '../LICENSE' }
  s.author           = { 'MixinNetwork' => 'dev@mixin.one' }
  s.source           = { :path => '.' }
  s.source_files     = 'Classes/**/*'
  s.dependency 'FlutterMacOS'

  s.platform = :osx, '12.0'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.swift_version = '5.0'
end
