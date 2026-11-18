# From this directory: cpack --config apk.cmake
cmake_minimum_required(VERSION 4.5)
set(CPACK_GENERATOR APK)
set(CPACK_PACKAGE_NAME phone-operator)
set(CPACK_PACKAGE_DESCRIPTION "Android phone motion operator")
set(CPACK_PACKAGE_VERSION 0.3.0)
set(CPACK_APK_VERSION_CODE 3)
set(CPACK_PACKAGE_FILE_NAME phone-operator-debug)
set(CPACK_PACKAGE_DIRECTORY "${CMAKE_CURRENT_LIST_DIR}/build")
set(CPACK_APK_MANIFEST "${CMAKE_CURRENT_LIST_DIR}/AndroidManifest.xml")
set(CPACK_APK_RESOURCE_DIRECTORIES "${CMAKE_CURRENT_LIST_DIR}/res")
set(CPACK_APK_MIN_SDK_VERSION 32)
set(CPACK_APK_COMPILE_SDK_VERSION 36)
set(CPACK_APK_TARGET_SDK_VERSION "${CPACK_APK_COMPILE_SDK_VERSION}")
set(CPACK_APK_BUILD_TOOLS_VERSION 36.1.0)

execute_process(COMMAND android info sdk
  OUTPUT_VARIABLE CPACK_APK_SDK_ROOT OUTPUT_STRIP_TRAILING_WHITESPACE
  COMMAND_ERROR_IS_FATAL ANY)
set(ENV{ANDROID_HOME} "${CPACK_APK_SDK_ROOT}")
set(sdk_packages "platforms/android-${CPACK_APK_COMPILE_SDK_VERSION}"
                 "build-tools/${CPACK_APK_BUILD_TOOLS_VERSION}")
if(NOT DEFINED ENV{ANDROID_NDK_HOME})
  set(ndk_package "ndk/29.0.14206865")
  list(APPEND sdk_packages "${ndk_package}")
  set(ENV{ANDROID_NDK_HOME} "${CPACK_APK_SDK_ROOT}/${ndk_package}")
endif()
set(CPACK_APK_NDK_ROOT "$ENV{ANDROID_NDK_HOME}")

# Even a no-op SDK install contacts the repository. Use the manager's local
# package records to request only what is missing from this installation.
foreach(package IN LISTS sdk_packages)
  if(NOT EXISTS "${CPACK_APK_SDK_ROOT}/${package}/package.xml")
    list(APPEND missing_packages "${package}")
  endif()
endforeach()
# Platform tools occupy a single shared slot. Keep an existing adb version.
if(NOT EXISTS "${CPACK_APK_SDK_ROOT}/platform-tools/package.xml")
  list(APPEND missing_packages platform-tools@37.0.1)
endif()
if(missing_packages)
  execute_process(COMMAND android "--sdk=${CPACK_APK_SDK_ROOT}" sdk
                  --ignore-outdated-xmls install ${missing_packages}
    COMMAND_ERROR_IS_FATAL ANY)
endif()

# Link against the same AAR that CPack merges, including its Maven dependencies.
set(arcore_version 1.57.0)
set(CPACK_APK_MAVEN_DEPENDENCIES "com.google.ar:core:${arcore_version}")
set(CPACK_APK_MAVEN_CACHE_DIRECTORY "${CPACK_PACKAGE_DIRECTORY}/maven")
set(artifact "com/google/ar/core/${arcore_version}/core-${arcore_version}.aar")
set(aar "${CPACK_APK_MAVEN_CACHE_DIRECTORY}/${artifact}")
file(DOWNLOAD "https://dl.google.com/dl/android/maven2/${artifact}" "${aar}"
  EXPECTED_HASH SHA256=df53bb8ea8e3a9f32e256b91909959d60b2e4c60d8fcc56b905b4c3e926f5c72)
set(abi arm64-v8a)
set(link_dir "${CPACK_PACKAGE_DIRECTORY}/arcore-${arcore_version}")
file(ARCHIVE_EXTRACT INPUT "${aar}" DESTINATION "${link_dir}"
  PATTERNS "jni/${abi}/libarcore_sdk_c.so")
set(libs "${CPACK_PACKAGE_DIRECTORY}/jni")
execute_process(
  COMMAND cargo ndk -t "${abi}" --platform "${CPACK_APK_MIN_SDK_VERSION}" -o "${libs}"
          rustc --locked --release --lib -- "-Lnative=${link_dir}/jni/${abi}"
  WORKING_DIRECTORY "${CMAKE_CURRENT_LIST_DIR}"
  COMMAND_ERROR_IS_FATAL ANY)
set(CPACK_INSTALLED_DIRECTORIES "${libs};/lib")

# Preserve the signing identity used by previous debug builds.
if(DEFINED ENV{PHONE_DEBUG_KEYSTORE})
  set(CPACK_APK_KEYSTORE "$ENV{PHONE_DEBUG_KEYSTORE}")
elseif(EXISTS "${CPACK_PACKAGE_DIRECTORY}/debug.keystore")
  set(CPACK_APK_KEYSTORE "${CPACK_PACKAGE_DIRECTORY}/debug.keystore")
endif()
if(CPACK_APK_KEYSTORE)
  set(CPACK_APK_KEY_ALIAS androiddebugkey)
  set(CPACK_APK_KEYSTORE_PASSWORD android)
endif()
