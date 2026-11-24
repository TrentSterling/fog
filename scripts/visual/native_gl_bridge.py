"""JSON command bridge for running Three.js against native surfaceless GLES.

Development capture utility only. This does not drive a browser. Input/output
are newline-delimited JSON. Each input is {commands:[{op,args}],query:{op,args}}.
The default framebuffer is an RGBA8 + depth24/stencil8 target, resized by
{op:"resize",args:[width,height]}. All WebGL object identifiers are native ints.
"""
import base64
import ctypes as C
import json
import pathlib
import sys
import traceback
import numpy as np
from gles_context import GLContext, U, I, P, F


TYPED = {
    'Float32Array': np.float32, 'Float64Array': np.float64,
    'Uint8Array': np.uint8, 'Uint8ClampedArray': np.uint8, 'Int8Array': np.int8,
    'Uint16Array': np.uint16, 'Int16Array': np.int16,
    'Uint32Array': np.uint32, 'Int32Array': np.int32,
}


def typed(value, dtype=None):
    if isinstance(value, dict) and '__typed' in value:
        arr = np.frombuffer(base64.b64decode(value['base64']), dtype=TYPED.get(value['__typed'], np.uint8)).copy()
        return arr.astype(dtype, copy=False) if dtype is not None else arr
    return np.asarray(value, dtype=dtype or np.float32)


class NativeBridge:
    def __init__(self, width=1280, height=800):
        self.gl = GLContext()
        self.cache = {}
        self.default_fbo = 0
        self.default_color = 0
        self.default_depth = 0
        self.width = self.height = 0
        self.resize(width, height)

    def fn(self, name, result=None, args=()):
        key = (name, result, tuple(args))
        if key not in self.cache:
            ptr = self.gl.egl.eglGetProcAddress(name.encode())
            if not ptr:
                raise RuntimeError('GLES entry point unavailable: ' + name)
            self.cache[key] = C.CFUNCTYPE(result, *args)(ptr)
        return self.cache[key]

    def call(self, name, values=(), signature=(), result=None):
        return self.fn(name, result, signature)(*values)

    def integer(self, enum, count=1):
        out = (I * count)()
        self.call('glGetIntegerv', (enum, out), (U, P))
        return out[0] if count == 1 else list(out)

    def floats(self, enum, count=1):
        out = (F * count)()
        self.call('glGetFloatv', (enum, out), (U, P))
        return float(out[0]) if count == 1 else list(out)

    def new(self, native_name):
        out = U()
        self.call(native_name, (1, C.byref(out)), (I, P))
        return out.value

    def resize(self, width, height):
        width, height = max(1, int(width)), max(1, int(height))
        previous_draw = self.integer(0x8CA6)
        previous_read = self.integer(0x8CAA)
        previous_texture = self.integer(0x8069)
        previous_renderbuffer = self.integer(0x8CA7)
        first = not self.default_fbo
        if first:
            self.default_fbo = self.new('glGenFramebuffers')
            self.default_color = self.new('glGenTextures')
            self.default_depth = self.new('glGenRenderbuffers')
        self.call('glBindTexture', (0x0DE1, self.default_color), (U, U))
        for pname, value in [(0x2800, 0x2601), (0x2801, 0x2601), (0x2802, 0x812F), (0x2803, 0x812F)]:
            self.call('glTexParameteri', (0x0DE1, pname, value), (U, U, I))
        self.call('glTexImage2D', (0x0DE1, 0, 0x8058, width, height, 0, 0x1908, 0x1401, None), (U, I, I, I, I, I, U, U, P))
        self.call('glBindRenderbuffer', (0x8D41, self.default_depth), (U, U))
        self.call('glRenderbufferStorage', (0x8D41, 0x88F0, width, height), (U, U, I, I))
        self.call('glBindFramebuffer', (0x8D40, self.default_fbo), (U, U))
        self.call('glFramebufferTexture2D', (0x8D40, 0x8CE0, 0x0DE1, self.default_color, 0), (U, U, U, U, I))
        self.call('glFramebufferRenderbuffer', (0x8D40, 0x821A, 0x8D41, self.default_depth), (U, U, U, U))
        status = self.call('glCheckFramebufferStatus', (0x8D40,), (U,), U)
        if status != 0x8CD5:
            raise RuntimeError(f'Native default framebuffer incomplete: {status:#x}')
        self.call('glBindTexture', (0x0DE1, previous_texture), (U, U))
        self.call('glBindRenderbuffer', (0x8D41, previous_renderbuffer), (U, U))
        self.call('glBindFramebuffer', (0x8CA9, self.default_fbo if first else previous_draw), (U, U))
        self.call('glBindFramebuffer', (0x8CA8, self.default_fbo if first else previous_read), (U, U))
        self.width, self.height = width, height
        return {'width': width, 'height': height}

    def parameter(self, enum):
        strings = {0x1F00, 0x1F01, 0x1F02, 0x8B8C, 0x1F03}
        if enum in strings:
            if enum == 0x1F03:
                count = self.integer(0x821D)
                get = self.fn('glGetStringi', C.c_char_p, (U, U))
                return ' '.join((get(0x1F03, i) or b'').decode() for i in range(count))
            return (self.gl.glGetString(enum) or b'').decode()
        if enum == 0x9245: return self.parameter(0x1F00)
        if enum == 0x9246: return self.parameter(0x1F01)
        if enum in [0x846D, 0x846E, 0x0B70]: return self.floats(enum, 2)
        if enum in [0x0C22, 0x8005]: return self.floats(enum, 4)
        if enum == 0x0D3A: return self.integer(enum, 2)
        if enum in [0x0BA2, 0x0C10, 0x0C23]: return self.integer(enum, 4)
        if enum == 0x86A3:
            n = self.integer(0x86A2)
            return self.integer(enum, n) if n else []
        if enum == 0x8E28: return False  # GPU_DISJOINT_EXT has no native WebGL analogue.
        if enum in [0x0B73, 0x0B21, 0x0B22, 0x0B23, 0x0B24, 0x0B25, 0x0B26]:
            return self.floats(enum)
        value = self.integer(enum)
        if enum in [0x8CA6, 0x8CAA] and value == self.default_fbo: return None
        return value

    def info_log(self, obj, kind):
        length = I()
        self.call('glGet' + kind + 'iv', (obj, 0x8B84, C.byref(length)), (U, U, P))
        out = C.create_string_buffer(max(1, length.value))
        self.call('glGet' + kind + 'InfoLog', (obj, len(out), None, out), (U, I, P, P))
        return out.value.decode(errors='replace')

    def active(self, program, index, kind):
        name = C.create_string_buffer(4096)
        length, size, value_type = I(), I(), U()
        self.call('glGetActive' + kind, (program, index, len(name), C.byref(length), C.byref(size), C.byref(value_type), name), (U, U, I, P, P, P, P))
        return {'name': name.value.decode(), 'size': size.value, 'type': value_type.value}

    def pointer(self, value):
        if value is None: return None, None
        if isinstance(value, (int, float)): return P(int(value)), None
        arr = typed(value)
        return P(arr.ctypes.data), arr

    def execute(self, op, a):
        if op == 'resize': return self.resize(*a)
        if op == 'description': return self.gl.description()
        if op == 'getParameter': return self.parameter(a[0])
        if op == 'getError': return self.gl.glGetError()
        if op == 'isContextLost': return False
        if op == 'getContextAttributes':
            return {'alpha': False, 'depth': True, 'stencil': True, 'antialias': False, 'premultipliedAlpha': True, 'preserveDrawingBuffer': True}
        if op == 'getSupportedExtensions': return self.parameter(0x1F03).split()
        if op.startswith('create'):
            kind = op[6:]
            if kind == 'Program': return self.call('glCreateProgram', (), (), U)
            if kind == 'Shader': return self.call('glCreateShader', a, (U,), U)
            plural = {'VertexArray': 'VertexArrays', 'TransformFeedback': 'TransformFeedbacks'}.get(kind, kind + 's')
            return self.new('glGen' + plural)
        if op.startswith('delete'):
            kind = op[6:]
            if kind in ['Shader', 'Program']:
                return self.call('glDelete' + kind, (a[0] or 0,), (U,))
            if kind == 'Sync': return self.call('glDeleteSync', (a[0],), (P,))
            plural = {'VertexArray': 'VertexArrays', 'TransformFeedback': 'TransformFeedbacks'}.get(kind, kind + 's')
            value = U(a[0] or 0)
            return self.call('glDelete' + plural, (1, C.byref(value)), (I, P))
        if op == 'shaderSource':
            source = C.c_char_p(a[1].encode())
            return self.call('glShaderSource', (a[0], 1, C.byref(source), None), (U, I, P, P))
        if op in ['getShaderParameter', 'getProgramParameter']:
            value = I()
            self.call('glGet' + ('Shader' if op == 'getShaderParameter' else 'Program') + 'iv', (a[0], a[1], C.byref(value)), (U, U, P))
            if a[1] in [0x8B81, 0x8B82, 0x8B83, 0x8B80, 0x91B1]: return bool(value.value)
            return value.value
        if op == 'getShaderInfoLog': return self.info_log(a[0], 'Shader')
        if op == 'getProgramInfoLog': return self.info_log(a[0], 'Program')
        if op == 'getActiveUniform': return self.active(a[0], a[1], 'Uniform')
        if op == 'getActiveAttrib': return self.active(a[0], a[1], 'Attrib')
        if op in ['getUniformLocation', 'getAttribLocation']:
            value = self.call('glG' + op[1:], (a[0], a[1].encode()), (U, C.c_char_p), I)
            return None if op == 'getUniformLocation' and value < 0 else value
        if op == 'getShaderPrecisionFormat':
            range_ = (I * 2)(); precision = I()
            self.call('glGetShaderPrecisionFormat', (a[0], a[1], range_, C.byref(precision)), (U, U, P, P))
            return {'rangeMin': range_[0], 'rangeMax': range_[1], 'precision': precision.value}
        if op == 'bindAttribLocation': return self.call('glBindAttribLocation', (a[0], a[1], a[2].encode()), (U, U, C.c_char_p))
        if op == 'bindFramebuffer': return self.call('glBindFramebuffer', (a[0], a[1] or self.default_fbo), (U, U))
        if op == 'checkFramebufferStatus': return self.call('glCheckFramebufferStatus', a, (U,), U)
        if op == 'bufferData':
            if isinstance(a[1], (int, float)):
                return self.call('glBufferData', (a[0], int(a[1]), None, a[2]), (U, C.c_ssize_t, P, U))
            data = typed(a[1])
            if len(a) > 3:
                data = data[int(a[3]):int(a[3]) + int(a[4])] if len(a) > 4 and a[4] else data[int(a[3]):]
            return self.call('glBufferData', (a[0], data.nbytes, data.ctypes.data, a[2]), (U, C.c_ssize_t, P, U))
        if op == 'bufferSubData':
            data = typed(a[2])
            if len(a) > 3:
                data = data[int(a[3]):int(a[3]) + int(a[4])] if len(a) > 4 and a[4] else data[int(a[3]):]
            return self.call('glBufferSubData', (a[0], int(a[1]), data.nbytes, data.ctypes.data), (U, C.c_ssize_t, C.c_ssize_t, P))
        if op in ['texImage2D', 'texSubImage2D', 'texImage3D', 'texSubImage3D']:
            signatures = {
                'texImage2D': (U, I, I, I, I, I, U, U, P),
                'texSubImage2D': (U, I, I, I, I, I, U, U, P),
                'texImage3D': (U, I, I, I, I, I, I, U, U, P),
                'texSubImage3D': (U, I, I, I, I, I, I, I, U, U, P),
            }
            sig = signatures[op]
            args = list(a[:len(sig)])
            if len(args) != len(sig):
                raise RuntimeError(op + ' needs raw pixel overload; image objects must be converted by JS')
            ptr, keep = self.pointer(args[-1])
            if len(a) > len(sig) and keep is not None:
                ptr = P(keep.ctypes.data + int(a[len(sig)]) * keep.dtype.itemsize)
            args[-1] = ptr
            return self.call('gl' + op[0].upper() + op[1:], args, sig)
        if op.startswith('compressedTex'):
            signatures = {
                'compressedTexImage2D': (U, I, U, I, I, I, I, P),
                'compressedTexSubImage2D': (U, I, I, I, I, I, U, I, P),
                'compressedTexImage3D': (U, I, U, I, I, I, I, I, P),
                'compressedTexSubImage3D': (U, I, I, I, I, I, I, I, U, I, P),
            }
            data = typed(a[-1]); args = a[:-1] + [data.nbytes, data.ctypes.data]
            return self.call('gl' + op[0].upper() + op[1:], args, signatures[op])
        if op.startswith('uniformMatrix'):
            if a[0] is None: return None
            sizes = {'2': 4, '3': 9, '4': 16, '2x3': 6, '2x4': 8, '3x2': 6, '3x4': 12, '4x2': 8, '4x3': 12}
            dim = op[len('uniformMatrix'):-2]
            data = typed(a[2], np.float32)
            if len(a) > 3: data = data[int(a[3]):int(a[3])+int(a[4])] if len(a)>4 and a[4] else data[int(a[3]):]
            return self.call('gl' + op[0].upper() + op[1:], (a[0], data.size // sizes[dim], bool(a[1]), data.ctypes.data), (I, I, U, P))
        if op.startswith('uniform') and op[7:8] in '1234':
            if a[0] is None: return None
            number = int(op[7]); suffix = op[8:]
            if suffix.endswith('v'):
                dtype = np.float32 if suffix == 'fv' else (np.uint32 if suffix == 'uiv' else np.int32)
                data = typed(a[1], dtype)
                if len(a) > 2: data = data[int(a[2]):int(a[2])+int(a[3])] if len(a)>3 and a[3] else data[int(a[2]):]
                return self.call('gl' + op[0].upper() + op[1:], (a[0], data.size // number, data.ctypes.data), (I, I, P))
            dtype = F if suffix == 'f' else (U if suffix == 'ui' else I)
            return self.call('gl' + op[0].upper() + op[1:], a, (I,) + (dtype,) * number)
        if op in ['drawBuffers', 'invalidateFramebuffer', 'invalidateSubFramebuffer']:
            if op == 'drawBuffers':
                data = typed(a[0], np.uint32)
                return self.call('glDrawBuffers', (data.size, data.ctypes.data), (I, P))
            data = typed(a[1], np.uint32)
            args = [a[0], data.size, data.ctypes.data] + a[2:]
            return self.call('gl' + op[0].upper() + op[1:], args, (U, I, P) + (I,)*(len(a)-2))
        if op in ['clearBufferfv', 'clearBufferiv', 'clearBufferuiv']:
            data = typed(a[2], np.float32 if op.endswith('fv') else np.uint32 if op.endswith('uiv') else np.int32)
            return self.call('gl' + op[0].upper() + op[1:], (a[0], a[1], data.ctypes.data), (U, I, P))
        if op == 'pixelStorei':
            # These three flags are WebGL image-upload behavior, not GLES
            # pixel-store state. Our app uploads raw unflipped DataTextures.
            if a[0] in [0x9240, 0x9241, 0x9243]: return None
            return self.call('glPixelStorei', a, (U, I))
        if op == 'readPixels':
            x, y, w, h, format_, type_ = a[:6]
            dtype = {0x1401: np.uint8, 0x1400: np.int8, 0x1403: np.uint16, 0x140B: np.uint16,
                     0x1402: np.int16, 0x1405: np.uint32, 0x1404: np.int32, 0x1406: np.float32}[type_]
            channels = {0x1908: 4, 0x1907: 3, 0x8227: 2, 0x1903: 1, 0x8D99: 4}.get(format_, 4)
            data = np.zeros(w*h*channels, dtype=dtype)
            self.call('glReadPixels', (x, y, w, h, format_, type_, data.ctypes.data), (I, I, I, I, U, U, P))
            name = {np.uint8:'Uint8Array',np.int8:'Int8Array',np.uint16:'Uint16Array',np.int16:'Int16Array',np.uint32:'Uint32Array',np.int32:'Int32Array',np.float32:'Float32Array'}[dtype]
            return {'__typed': name, 'base64': base64.b64encode(data.tobytes()).decode(), 'width': w, 'height': h}
        if op == 'getInternalformatParameter':
            count = I()
            self.call('glGetInternalformativ', (a[0], a[1], 0x9380, 1, C.byref(count)), (U, U, U, I, P))
            values = (I * max(1, count.value))()
            self.call('glGetInternalformativ', (a[0], a[1], a[2], len(values), values), (U, U, U, I, P))
            return list(values)[:count.value]
        if op == 'getRenderbufferParameter':
            value=I(); self.call('glGetRenderbufferParameteriv',(a[0],a[1],C.byref(value)),(U,U,P)); return value.value
        if op == 'getFramebufferAttachmentParameter':
            value=I(); self.call('glGetFramebufferAttachmentParameteriv',(a[0],a[1],a[2],C.byref(value)),(U,U,U,P)); return value.value
        if op == 'getBufferParameter':
            value=I(); self.call('glGetBufferParameteriv',(a[0],a[1],C.byref(value)),(U,U,P)); return value.value
        if op == 'getTexParameter':
            value=I(); self.call('glGetTexParameteriv',(a[0],a[1],C.byref(value)),(U,U,P)); return value.value
        if op == 'fenceSync': return self.call('glFenceSync', a, (U,U), P)
        if op == 'clientWaitSync': return self.call('glClientWaitSync', a, (P,U,C.c_ulonglong), U)
        if op == 'getQueryParameter':
            value=C.c_ulonglong(); self.call('glGetQueryObjectui64v',(a[0],a[1],C.byref(value)),(U,U,P)); return value.value
        if op.startswith('is'):
            return bool(self.call('gl' + op[0].upper()+op[1:], (a[0] or 0,), (U,), U))

        signatures = {
            'activeTexture': (U,), 'bindTexture': (U,U), 'bindBuffer': (U,U), 'bindRenderbuffer': (U,U),
            'bindVertexArray': (U,), 'bindTransformFeedback': (U,U), 'bindSampler': (U,U),
            'bindBufferBase': (U,U,U), 'bindBufferRange': (U,U,U,C.c_ssize_t,C.c_ssize_t),
            'attachShader': (U,U), 'detachShader': (U,U), 'compileShader': (U,), 'linkProgram': (U,), 'validateProgram':(U,), 'useProgram': (U,),
            'enable': (U,), 'disable': (U,), 'clear': (U,), 'clearColor': (F,F,F,F), 'clearDepth': (F,), 'clearStencil': (I,),
            'colorMask': (U,U,U,U), 'depthMask': (U,), 'depthFunc': (U,), 'depthRange': (F,F),
            'cullFace': (U,), 'frontFace': (U,), 'lineWidth': (F,), 'polygonOffset': (F,F), 'sampleCoverage': (F,U),
            'blendColor':(F,F,F,F), 'blendEquation': (U,), 'blendEquationSeparate': (U,U), 'blendFunc': (U,U), 'blendFuncSeparate': (U,U,U,U),
            'stencilFunc': (U,I,U), 'stencilFuncSeparate': (U,U,I,U), 'stencilMask': (U,), 'stencilMaskSeparate':(U,U),
            'stencilOp': (U,U,U), 'stencilOpSeparate':(U,U,U,U), 'viewport':(I,I,I,I), 'scissor':(I,I,I,I),
            'enableVertexAttribArray': (U,), 'disableVertexAttribArray': (U,),
            'vertexAttribPointer': (U,I,U,U,I,P), 'vertexAttribIPointer': (U,I,U,I,P), 'vertexAttribDivisor':(U,U),
            'vertexAttrib1f':(U,F), 'vertexAttrib2f':(U,F,F), 'vertexAttrib3f':(U,F,F,F), 'vertexAttrib4f':(U,F,F,F,F),
            'vertexAttribI4i':(U,I,I,I,I), 'vertexAttribI4ui':(U,U,U,U,U),
            'drawArrays':(U,I,I), 'drawElements':(U,I,U,P), 'drawArraysInstanced':(U,I,I,I), 'drawElementsInstanced':(U,I,U,P,I),
            'drawRangeElements':(U,U,U,I,U,P), 'drawBuffers':(I,P), 'readBuffer':(U,),
            'texParameteri':(U,U,I), 'texParameterf':(U,U,F), 'samplerParameteri':(U,U,I), 'samplerParameterf':(U,U,F),
            'texStorage2D':(U,I,U,I,I), 'texStorage3D':(U,I,U,I,I,I), 'generateMipmap':(U,),
            'framebufferTexture2D':(U,U,U,U,I), 'framebufferTextureLayer':(U,U,U,I,I), 'framebufferRenderbuffer':(U,U,U,U),
            'renderbufferStorage':(U,U,I,I), 'renderbufferStorageMultisample':(U,I,U,I,I),
            'blitFramebuffer':(I,I,I,I,I,I,I,I,U,U), 'copyTexImage2D':(U,I,U,I,I,I,I,I),
            'copyTexSubImage2D':(U,I,I,I,I,I,I,I), 'copyTexSubImage3D':(U,I,I,I,I,I,I,I,I),
            'copyBufferSubData':(U,U,C.c_ssize_t,C.c_ssize_t,C.c_ssize_t),
            'clearBufferfi':(U,I,F,I), 'hint':(U,U), 'finish':(), 'flush':(),
            'beginQuery':(U,U), 'endQuery':(U,), 'beginTransformFeedback':(U,), 'endTransformFeedback':(),
            'pauseTransformFeedback':(), 'resumeTransformFeedback':(), 'waitSync':(P,U,C.c_ulonglong),
        }
        if op in signatures:
            native = {'clearDepth':'glClearDepthf','depthRange':'glDepthRangef'}.get(op, 'gl' + op[0].upper() + op[1:])
            sig = signatures[op]
            values = [0 if v is None else v for v in a]
            return self.call(native, values, sig)
        raise RuntimeError('Unimplemented native GL bridge operation: ' + op)


def main():
    width = int(sys.argv[1]) if len(sys.argv)>1 else 1280
    height = int(sys.argv[2]) if len(sys.argv)>2 else 800
    bridge = NativeBridge(width,height)
    # Protocol begins immediately; diagnostics only on stderr.
    for line in sys.stdin:
        if not line.strip(): continue
        current = None
        try:
            request = json.loads(line)
            for current in request.get('commands', []):
                bridge.execute(current['op'], current.get('args', []))
            current = request.get('query')
            result = bridge.execute(current['op'], current.get('args', [])) if current else None
            sys.stdout.write(json.dumps({'result': result}, separators=(',',':')) + '\n')
        except Exception as error:
            failed_op = current.get('op') if isinstance(current, dict) else None
            sys.stdout.write(json.dumps({'error': str(error), 'op': failed_op, 'trace': traceback.format_exc(limit=3)}, separators=(',',':')) + '\n')
        sys.stdout.flush()


if __name__ == '__main__':
    main()
