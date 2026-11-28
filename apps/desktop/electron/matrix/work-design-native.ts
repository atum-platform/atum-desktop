// Runs on the same no-follow, same-volume snapshot as the native Office gate.
export const nativeWorkDesign = String.raw`
import base64, math, struct
from html.entities import html5

DESIGN_MAX_BYTES = 512 * 1024
DESIGN_MAX_SIDE = 2048
SVG_NS = '{http://www.w3.org/2000/svg}'
XLINK_HREF = '{http://www.w3.org/1999/xlink}href'
XML_SPACE = '{http://www.w3.org/XML/1998/namespace}space'
HTML_TAGS = set('html head title meta style body main article section header footer aside nav div span p h1 h2 h3 h4 h5 h6 ul ol li dl dt dd figure figcaption strong em b i small time table caption thead tbody tfoot tr th td br hr blockquote sup sub code pre u s mark abbr cite q address'.split())
SVG_TAGS = set('svg g defs symbol use title desc style rect circle ellipse line polyline polygon path text tspan marker clipPath linearGradient radialGradient stop filter feDropShadow feGaussianBlur feOffset feFlood feComposite feMerge feMergeNode feBlend feColorMatrix pattern mask textPath'.split())
HTML_ATTRS = set('id class style lang dir title role aria-label aria-hidden colspan rowspan scope datetime'.split())
SVG_ATTRS = HTML_ATTRS | set('width height viewBox preserveAspectRatio version x y x1 x2 y1 y2 cx cy r rx ry d points dx dy transform fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset opacity color font-family font-size font-weight font-style text-anchor dominant-baseline letter-spacing marker-start marker-mid marker-end markerWidth markerHeight markerUnits orient refX refY clip-path clip-rule clipPathUnits gradientUnits gradientTransform spreadMethod offset stop-color stop-opacity fx fy fr href'.split())
SVG_ATTRS |= {XLINK_HREF, XML_SPACE} | set('filter mask stdDeviation in in2 result operator mode values type flood-color flood-opacity patternUnits patternContentUnits maskUnits'.split())
FRAGMENT = r'#[A-Za-z_][A-Za-z0-9_.-]*'
CSS_FUNCTIONS = set('rgb rgba hsl hsla hwb lab lch oklab oklch color color-mix calc min max clamp var env repeat minmax fit-content linear-gradient radial-gradient conic-gradient repeating-linear-gradient repeating-radial-gradient translate translatex translatey scale scalex scaley rotate skew skewx skewy matrix cubic-bezier steps not is where has nth-child nth-of-type and or'.split())
CSS_TOKENS = re.compile(r'(?P<string>"[^"\\\r\n\f]*"|\'[^\'\\\r\n\f]*\')|(?P<comment>/\*[\s\S]*?\*/)|["\'\\]|/\*')
VIEWBOX_NUMBER = r'[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?'

def design_css(value):
    # For a static design, embedded CSS can refer to local SVG paint servers.
    # Keep escapes, arbitrary at-rules and URL-bearing functions out of the dialect.
    def replace_token(match):
        if match.lastgroup == 'comment':
            return ' '
        if match.lastgroup == 'string':
            return '""'
        raise ValueError()

    value = CSS_TOKENS.sub(replace_token, value.lower())
    value = re.sub(r'url\(\s*' + FRAGMENT + r'\s*\)', '', value)
    value = re.sub(r'@media\b', '', value)
    if '\\' in value or '@' in value or any(
        name not in CSS_FUNCTIONS for name in re.findall(r'([\w-]+)\s*\(', value)
    ):
        raise ValueError()

def design_entity(match):
    value = html5.get(match[0][1:])
    return ''.join('&#' + str(ord(char)) + ';' for char in value) if value is not None else match[0]

def design_svg_size(page):
    if 'width' in page.attrib or 'height' in page.attrib:
        dimensions = [page.attrib[key] for key in ('width', 'height')]
        if any(not re.fullmatch(r'[0-9]{1,4}(?:px)?', value) for value in dimensions):
            raise ValueError()
        return tuple(int(value.removesuffix('px')) for value in dimensions)

    viewbox = re.split(r'\s*,\s*|\s+', page.attrib['viewBox'].strip())
    if len(viewbox) != 4 or any(not re.fullmatch(VIEWBOX_NUMBER, value) for value in viewbox):
        raise ValueError()
    x, y, width, height = map(float, viewbox)
    if not all(map(math.isfinite, (x, y))) or not all(0.5 <= side <= DESIGN_MAX_SIDE for side in (width, height)):
        raise ValueError()
    return (int(width + 0.5), int(height + 0.5))

def work_design_dimensions(data, format):
    try:
        source = data.decode('utf-8')
        if format == 'html':
            if source[:15].lower() != '<!doctype html>':
                raise ValueError()
            source = source[15:]
        if any(token in source for token in ('<!', '<?', '\0')):
            raise ValueError()
        if format == 'html':
            source = re.sub(r'&[A-Za-z][A-Za-z0-9]*;', design_entity, source)
        page = ElementTree.fromstring(source)
        if format == 'html':
            if (page.tag != 'html' or [child.tag for child in page] != ['head', 'body'] or
                not len(page[0]) or page[0][0].tag != 'meta' or page[0][0].get('charset', '').lower() != 'utf-8'):
                raise ValueError()
            size = (1200, 1600)
        else:
            if page.tag != SVG_NS + 'svg':
                raise ValueError()
            size = design_svg_size(page)
            if not all(0 < side <= DESIGN_MAX_SIDE for side in size):
                raise ValueError()

        for node in page.iter():
            svg = node.tag.startswith(SVG_NS)
            tag = node.tag.removeprefix(SVG_NS)
            if tag not in (SVG_TAGS if svg else HTML_TAGS) or (format == 'svg' and not svg):
                raise ValueError()
            if tag == 'style':
                if len(node) or '<' in (node.text or ''):
                    raise ValueError()
                design_css(node.text or '')
            for key, value in node.attrib.items():
                if tag == 'meta' and key == 'charset' and value.lower() == 'utf-8':
                    continue
                if key not in (SVG_ATTRS if svg else HTML_ATTRS):
                    raise ValueError()
                if key in {'href', XLINK_HREF} and (
                    tag not in {'use', 'textPath'} or not re.fullmatch(FRAGMENT, value)
                ):
                    raise ValueError()
                if key in {'style', 'fill', 'stroke', 'clip-path', 'marker-start', 'marker-mid', 'marker-end', 'filter', 'mask'}:
                    design_css(value)
        return size
    except (ValueError, KeyError, ElementTree.ParseError):
        raise Refused('unavailable')

def prepare_work_preview(stage, payload, format):
    with os.fdopen(os.dup(payload), 'rb') as stream:
        data = stream.read(DESIGN_MAX_BYTES + 1)
    if len(data) > DESIGN_MAX_BYTES:
        raise Refused('unavailable')
    width, height = work_design_dimensions(data, format)
    print(json.dumps({'renderWorkDesign':base64.b64encode(data).decode('ascii'),
                      'format':format, 'width':width, 'height':height}), flush=True)
    response = json.loads(sys.stdin.readline(2 * WORK_MAX_BYTES))
    if response.get('unavailable'): raise OSError(errno.EIO, 'design renderer unavailable')
    png = base64.b64decode(response.get('png', ''), validate=True)
    if (not 33 < len(png) <= WORK_MAX_BYTES or
        png[:16] != b'\x89PNG\r\n\x1a\n\0\0\0\rIHDR' or
        struct.unpack('>II', png[16:24]) != (width, height)):
        raise Refused('unavailable')
    try: os.unlink('preview-payload', dir_fd=stage)
    except FileNotFoundError: pass
    fd = os.open('preview-payload', os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600, dir_fd=stage)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(png)
        stream.flush()
        os.fsync(stream.fileno())
`
