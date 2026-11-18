/* Compile-only checks against pinned official ARCore + Android NDK headers.
 * This is not linked into either app. */
#include <stddef.h>
#include <arcore_c_api.h>
#include <camera/NdkCameraMetadata.h>
#include <camera/NdkCameraMetadataTags.h>
#include <EGL/egl.h>
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
_Static_assert(sizeof(ArImageMetadata_const_entry) == 24, "metadata size");
_Static_assert(offsetof(ArImageMetadata_const_entry, data) == 16, "metadata pointer");
_Static_assert(offsetof(ArImageMetadata_const_entry, count) == 8, "metadata count");
_Static_assert(offsetof(ArImageMetadata_const_entry, type) == 4, "metadata type");
_Static_assert(ACAMERA_SENSOR_TIMESTAMP == (14<<16)+16, "timestamp tag");
_Static_assert(ACAMERA_TYPE_INT64 == 3, "metadata scalar type");
_Static_assert(AR_TRACKING_STATE_TRACKING == 0 && AR_UPDATE_MODE_BLOCKING == 0, "state");
_Static_assert(AR_AVAILABILITY_UNKNOWN_CHECKING == 1 && AR_AVAILABILITY_UNKNOWN_TIMED_OUT == 2, "availability");
_Static_assert(AR_AVAILABILITY_UNSUPPORTED_DEVICE_NOT_CAPABLE == 100 && AR_INSTALL_STATUS_INSTALLED == 0 && AR_INSTALL_STATUS_INSTALL_REQUESTED == 1, "install");
_Static_assert(AR_PLANE_FINDING_MODE_DISABLED == 0 && AR_LIGHT_ESTIMATION_MODE_DISABLED == 0 && AR_DEPTH_MODE_DISABLED == 0 && AR_INSTANT_PLACEMENT_MODE_DISABLED == 0 && AR_CLOUD_ANCHOR_MODE_DISABLED == 0 && AR_GEOSPATIAL_MODE_DISABLED == 0 && AR_SEMANTIC_MODE_DISABLED == 0 && AR_IMAGE_STABILIZATION_MODE_OFF == 0 && AR_TEXTURE_UPDATE_MODE_BIND_TO_TEXTURE_EXTERNAL_OES == 0, "configuration");
_Static_assert(EGL_NONE==0x3038 && EGL_OPENGL_ES_API==0x30a0 && EGL_CONTEXT_CLIENT_VERSION==0x3098 && EGL_PBUFFER_BIT==1 && EGL_OPENGL_ES2_BIT==4, "EGL constants");
_Static_assert(GL_TEXTURE_EXTERNAL_OES==0x8d65 && GL_LINEAR==0x2601 && GL_CLAMP_TO_EDGE==0x812f, "GL constants");
