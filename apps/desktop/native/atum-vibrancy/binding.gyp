{
  "targets": [
    {
      "target_name": "atum_vibrancy",
      "conditions": [
        [
          "OS=='mac'",
          {
            "sources": ["src/atum_vibrancy.mm"],
            "defines": ["NAPI_VERSION=8"],
            "xcode_settings": {
              "CLANG_ENABLE_OBJC_ARC": "YES",
              "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
              "MACOSX_DEPLOYMENT_TARGET": "11.0"
            },
            "link_settings": {
              "libraries": [
                "$(SDKROOT)/System/Library/Frameworks/Cocoa.framework",
                "$(SDKROOT)/System/Library/Frameworks/QuartzCore.framework"
              ]
            }
          }
        ]
      ]
    }
  ]
}
