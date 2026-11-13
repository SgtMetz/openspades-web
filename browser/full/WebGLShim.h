// Included only by the generated copy of Gui/SDLGLDevice.cpp (see prepare.py).
// Redirects the GL calls the original device makes to WebGL 2-compatible implementations in
// WebGLCompat.cpp. The renderer (Sources/Draw) and the shader files stay byte-for-byte upstream.
#pragma once
#include <GL/glew.h>

extern "C" {
GLuint osweb_glCreateShader(GLenum type);
void osweb_glShaderSource(GLuint shader, GLsizei count, const GLchar *const *string, const GLint *length);
void osweb_glCompileShader(GLuint shader);
void osweb_glGetShaderiv(GLuint shader, GLenum pname, GLint *params);
void osweb_glGetShaderInfoLog(GLuint shader, GLsizei size, GLsizei *length, GLchar *log);
void osweb_glDeleteShader(GLuint shader);
void osweb_glAttachShader(GLuint program, GLuint shader);
void osweb_glDetachShader(GLuint program, GLuint shader);
void osweb_glLinkProgram(GLuint program);
void osweb_glGetProgramiv(GLuint program, GLenum pname, GLint *params);
void osweb_glGetProgramInfoLog(GLuint program, GLsizei size, GLsizei *length, GLchar *log);
void osweb_glDeleteProgram(GLuint program);
void osweb_glValidateProgram(GLuint program);
GLint osweb_glGetUniformLocation(GLuint program, const GLchar *name);
GLint osweb_glGetAttribLocation(GLuint program, const GLchar *name);
void osweb_glBindAttribLocation(GLuint program, GLuint index, const GLchar *name);
void osweb_glEnable(GLenum cap);
void osweb_glDisable(GLenum cap);
void osweb_glDrawArrays(GLenum mode, GLint first, GLsizei count);
void osweb_glDrawElements(GLenum mode, GLsizei count, GLenum type, const void *indices);
void osweb_glDrawArraysInstanced(GLenum mode, GLint first, GLsizei count, GLsizei instances);
void osweb_glDrawElementsInstanced(GLenum mode, GLsizei count, GLenum type, const void *indices,
                                   GLsizei instances);
void osweb_glActiveTexture(GLenum unit);
void osweb_glBindTexture(GLenum target, GLuint texture);
void osweb_glDeleteTextures(GLsizei n, const GLuint *textures);
void osweb_glTexImage2D(GLenum target, GLint level, GLint internal, GLsizei w, GLsizei h, GLint border,
                        GLenum format, GLenum type, const void *data);
void osweb_glTexImage3D(GLenum target, GLint level, GLint internal, GLsizei w, GLsizei h, GLsizei d,
                        GLint border, GLenum format, GLenum type, const void *data);
void osweb_glTexSubImage2D(GLenum target, GLint level, GLint x, GLint y, GLsizei w, GLsizei h,
                           GLenum format, GLenum type, const void *data);
void osweb_glTexSubImage3D(GLenum target, GLint level, GLint x, GLint y, GLint z, GLsizei w, GLsizei h,
                           GLsizei d, GLenum format, GLenum type, const void *data);
void osweb_glCopyTexSubImage2D(GLenum target, GLint level, GLint xoff, GLint yoff, GLint x, GLint y,
                               GLsizei w, GLsizei h);
void osweb_glRenderbufferStorage(GLenum target, GLenum internal, GLsizei w, GLsizei h);
void osweb_glRenderbufferStorageMultisample(GLenum target, GLsizei samples, GLenum internal, GLsizei w,
                                            GLsizei h);
void osweb_glBeginQuery(GLenum target, GLuint id);
void osweb_glEndQuery(GLenum target);
}

#define glCreateShader osweb_glCreateShader
#define glShaderSource osweb_glShaderSource
#define glCompileShader osweb_glCompileShader
#define glGetShaderiv osweb_glGetShaderiv
#define glGetShaderInfoLog osweb_glGetShaderInfoLog
#define glDeleteShader osweb_glDeleteShader
#define glAttachShader osweb_glAttachShader
#define glDetachShader osweb_glDetachShader
#define glLinkProgram osweb_glLinkProgram
#define glGetProgramiv osweb_glGetProgramiv
#define glGetProgramInfoLog osweb_glGetProgramInfoLog
#define glDeleteProgram osweb_glDeleteProgram
#define glValidateProgram osweb_glValidateProgram
#define glGetUniformLocation osweb_glGetUniformLocation
#define glGetAttribLocation osweb_glGetAttribLocation
#define glBindAttribLocation osweb_glBindAttribLocation
#define glEnable osweb_glEnable
#define glDisable osweb_glDisable
#define glDrawArrays osweb_glDrawArrays
#define glDrawElements osweb_glDrawElements
#define glDrawArraysInstanced osweb_glDrawArraysInstanced
#define glDrawElementsInstanced osweb_glDrawElementsInstanced
#define glActiveTexture osweb_glActiveTexture
#define glBindTexture osweb_glBindTexture
#define glDeleteTextures osweb_glDeleteTextures
#define glTexImage2D osweb_glTexImage2D
#define glTexImage3D osweb_glTexImage3D
#define glTexSubImage2D osweb_glTexSubImage2D
#define glTexSubImage3D osweb_glTexSubImage3D
#define glCopyTexSubImage2D osweb_glCopyTexSubImage2D
#define glRenderbufferStorage osweb_glRenderbufferStorage
#define glRenderbufferStorageMultisample osweb_glRenderbufferStorageMultisample
#define glBeginQuery osweb_glBeginQuery
#define glEndQuery osweb_glEndQuery
