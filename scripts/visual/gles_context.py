"""Native EGL/GLES3 validation of FogLab's original GPU shader source.

This is an offline development diagnostic, not part of the deliverable.
No browser configuration or browser access is used.
"""
import ctypes as C
import ctypes.util
import numpy as np

U = C.c_uint
I = C.c_int
P = C.c_void_p
F = C.c_float


class GLContext:
    def __init__(self):
        self.egl = C.CDLL(ctypes.util.find_library('EGL') or 'libEGL.so.1')
        e = self.egl
        e.eglGetProcAddress.restype = P
        e.eglGetProcAddress.argtypes = [C.c_char_p]
        e.eglGetPlatformDisplay.restype = P
        e.eglGetPlatformDisplay.argtypes = [U, P, P]
        e.eglInitialize.restype = U
        e.eglInitialize.argtypes = [P, C.POINTER(I), C.POINTER(I)]
        e.eglBindAPI.restype = U
        e.eglBindAPI.argtypes = [U]
        e.eglChooseConfig.restype = U
        e.eglChooseConfig.argtypes = [P, C.POINTER(I), C.POINTER(P), I, C.POINTER(I)]
        e.eglCreateContext.restype = P
        e.eglCreateContext.argtypes = [P, P, P, C.POINTER(I)]
        e.eglCreatePbufferSurface.restype = P
        e.eglCreatePbufferSurface.argtypes = [P, P, C.POINTER(I)]
        e.eglMakeCurrent.restype = U
        e.eglMakeCurrent.argtypes = [P, P, P, P]
        e.eglGetError.restype = U

        self.display = e.eglGetPlatformDisplay(0x31DD, None, None)  # EGL_PLATFORM_SURFACELESS_MESA
        major, minor = I(), I()
        self._check(e.eglInitialize(self.display, C.byref(major), C.byref(minor)), 'eglInitialize')
        self._check(e.eglBindAPI(0x30A0), 'eglBindAPI GLES')
        attrib = (I * 15)(0x3033, 1, 0x3040, 0x40, 0x3024, 8, 0x3023, 8, 0x3022, 8, 0x3021, 8, 0x3025, 0, 0x3038)
        config, count = P(), I()
        self._check(e.eglChooseConfig(self.display, attrib, C.byref(config), 1, C.byref(count)), 'eglChooseConfig')
        if not count.value:
            raise RuntimeError('No GLES3 EGL configuration')
        ctx_attrs = (I * 3)(0x3098, 3, 0x3038)
        self.context = e.eglCreateContext(self.display, config, None, ctx_attrs)
        self._check(self.context, 'eglCreateContext')
        surf_attrs = (I * 5)(0x3057, 16, 0x3056, 16, 0x3038)
        self.surface = e.eglCreatePbufferSurface(self.display, config, surf_attrs)
        self._check(self.surface, 'eglCreatePbufferSurface')
        self._check(e.eglMakeCurrent(self.display, self.surface, self.surface, self.context), 'eglMakeCurrent')

        signatures = {
            'glGetString': (C.c_char_p, [U]),
            'glGetError': (U, []),
            'glCreateShader': (U, [U]),
            'glShaderSource': (None, [U, I, C.POINTER(C.c_char_p), C.POINTER(I)]),
            'glCompileShader': (None, [U]),
            'glGetShaderiv': (None, [U, U, C.POINTER(I)]),
            'glGetShaderInfoLog': (None, [U, I, C.POINTER(I), P]),
            'glCreateProgram': (U, []),
            'glAttachShader': (None, [U, U]),
            'glBindAttribLocation': (None, [U, U, C.c_char_p]),
            'glLinkProgram': (None, [U]),
            'glGetProgramiv': (None, [U, U, C.POINTER(I)]),
            'glGetProgramInfoLog': (None, [U, I, C.POINTER(I), P]),
            'glDeleteShader': (None, [U]),
            'glUseProgram': (None, [U]),
            'glGetUniformLocation': (I, [U, C.c_char_p]),
            'glUniform1f': (None, [I, F]),
            'glUniform1i': (None, [I, I]),
            'glUniform2f': (None, [I, F, F]),
            'glUniform4fv': (None, [I, I, P]),
            'glGenTextures': (None, [I, C.POINTER(U)]),
            'glBindTexture': (None, [U, U]),
            'glActiveTexture': (None, [U]),
            'glTexParameteri': (None, [U, U, I]),
            'glTexImage2D': (None, [U, I, I, I, I, I, U, U, P]),
            'glGenFramebuffers': (None, [I, C.POINTER(U)]),
            'glBindFramebuffer': (None, [U, U]),
            'glFramebufferTexture2D': (None, [U, U, U, U, I]),
            'glCheckFramebufferStatus': (U, [U]),
            'glGenVertexArrays': (None, [I, C.POINTER(U)]),
            'glBindVertexArray': (None, [U]),
            'glGenBuffers': (None, [I, C.POINTER(U)]),
            'glBindBuffer': (None, [U, U]),
            'glBufferData': (None, [U, C.c_ssize_t, P, U]),
            'glEnableVertexAttribArray': (None, [U]),
            'glVertexAttribPointer': (None, [U, I, U, U, I, P]),
            'glViewport': (None, [I, I, I, I]),
            'glDrawArrays': (None, [U, I, I]),
            'glReadPixels': (None, [I, I, I, I, U, U, P]),
            'glFinish': (None, []),
        }
        for name, (result, args) in signatures.items():
            ptr = e.eglGetProcAddress(name.encode())
            if not ptr:
                raise RuntimeError('Missing GLES entry point: ' + name)
            setattr(self, name, C.CFUNCTYPE(result, *args)(ptr))

    def _check(self, ok, label):
        if not ok:
            raise RuntimeError(f'{label} failed: EGL {self.egl.eglGetError():#x}')

    def compile_program(self, vertex, fragment):
        def shader(kind, source):
            handle = self.glCreateShader(kind)
            source_bytes = C.c_char_p(source.encode())
            self.glShaderSource(handle, 1, C.byref(source_bytes), None)
            self.glCompileShader(handle)
            success = I()
            self.glGetShaderiv(handle, 0x8B81, C.byref(success))
            if not success.value:
                log = C.create_string_buffer(20000)
                self.glGetShaderInfoLog(handle, len(log), None, log)
                raise RuntimeError(log.value.decode() + '\n' + source)
            return handle
        vs, fs = shader(0x8B31, vertex), shader(0x8B30, fragment)
        program = self.glCreateProgram()
        self.glAttachShader(program, vs)
        self.glAttachShader(program, fs)
        self.glBindAttribLocation(program, 0, b'position')
        self.glLinkProgram(program)
        status = I()
        self.glGetProgramiv(program, 0x8B82, C.byref(status))
        if not status.value:
            log = C.create_string_buffer(20000)
            self.glGetProgramInfoLog(program, len(log), None, log)
            raise RuntimeError(log.value.decode())
        self.glDeleteShader(vs)
        self.glDeleteShader(fs)
        return program

    def description(self):
        return {name: self.glGetString(enum).decode() for name, enum in [('vendor', 0x1F00), ('renderer', 0x1F01), ('version', 0x1F02)]}

