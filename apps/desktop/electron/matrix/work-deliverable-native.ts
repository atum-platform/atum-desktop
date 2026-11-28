import { nativeWorkDesign } from './work-design-native'

// Runs inside drive-import-native's isolated helper, sharing its fd-relative primitives.
export const nativeWorkPlacement = String.raw`
from contextlib import ExitStack
import fcntl, zipfile
from xml.etree import ElementTree

WORK_MAX_BYTES = 8 * 1024 * 1024
WORK_PARTS = re.compile(
    r'(?:\[Content_Types\]\.xml|_rels/\.rels|docProps/(?:app|core)\.xml|docProps/thumbnail\.jpeg|'
    r'customXml/(?:_rels/item1\.xml\.rels|item1\.xml|itemProps1\.xml)|'
    r'word/(?:_rels/document\.xml\.rels|document\.xml|styles(?:WithEffects)?\.xml|'
    r'settings\.xml|webSettings\.xml|fontTable\.xml|numbering\.xml|theme/theme1\.xml))'
)
WORD = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
TYPES = '{http://schemas.openxmlformats.org/package/2006/content-types}'
RELS = '{http://schemas.openxmlformats.org/package/2006/relationships}'
OFFICE_DOCUMENT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument'
MAIN_PART = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'

def work_parts(parts):
    if not parts or any(
        not part or part.startswith('.') or len(os.fsencode(part)) > 200
        or any(ord(c) < 32 or ord(c) == 127 or c in '/\\:' for c in part)
        for part in parts
    ): raise Refused('unavailable')
    return parts

def work_identity(fd):
    s = os.fstat(fd)
    return [s.st_dev, s.st_ino]

def work_hash(fd, parent, name):
    s = os.fstat(fd)
    if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or not 0 < s.st_size <= WORK_MAX_BYTES: raise Changed()
    os.lseek(fd, 0, os.SEEK_SET)
    with os.fdopen(os.dup(fd), 'rb') as stream:
        digest = hashlib.sha256(stream.read(WORK_MAX_BYTES + 1)).hexdigest()
    if identity(s) != identity(os.fstat(fd)) or identity(s) != identity(os.stat(name, dir_fd=parent, follow_symlinks=False)):
        raise Changed()
    return {'sha256':digest, 'size':s.st_size, 'dev':s.st_dev, 'ino':s.st_ino}

def validate_work_docx(fd):
    try:
        with os.fdopen(os.dup(fd), 'rb') as stream, zipfile.ZipFile(stream) as archive:
            parts = archive.infolist()
            names = {part.filename for part in parts}
            if (len(names) != len(parts) or len(parts) > 24 or
                sum(part.file_size for part in parts) > 8 * WORK_MAX_BYTES or
                not {'[Content_Types].xml', '_rels/.rels', 'word/document.xml'} <= names):
                raise ValueError()
            for part in parts:
                name = part.filename
                if not WORK_PARTS.fullmatch(name): raise ValueError()
                data = archive.read(part)
                if name.endswith('.jpeg'): continue
                xml = data.decode('utf-8')
                if '\0' in xml or '<!DOCTYPE' in xml or '<!ENTITY' in xml: raise ValueError()
                tree = ElementTree.fromstring(xml)
                if name == '[Content_Types].xml' and (
                    tree.tag != TYPES+'Types' or not any(
                        node.get('PartName') == '/word/document.xml' and node.get('ContentType') == MAIN_PART
                        for node in tree.findall(TYPES+'Override')
                    )
                ): raise ValueError()
                if name.endswith('.rels'):
                    if tree.tag != RELS+'Relationships' or any(
                        node.tag != RELS+'Relationship' or node.get('TargetMode', 'Internal') != 'Internal' or
                        any(c in node.get('Target', '') for c in ':\\%') for node in tree
                    ): raise ValueError()
                    if name == '_rels/.rels' and [
                        node.get('Target') for node in tree if node.get('Type') == OFFICE_DOCUMENT
                    ] != ['word/document.xml']: raise ValueError()
                if name == 'word/document.xml' and (
                    tree.tag != WORD+'document' or tree.find(WORD+'body') is None or
                    any(node.tag in {WORD+'fldSimple',WORD+'instrText',WORD+'delInstrText',WORD+'object',WORD+'altChunk'} for node in tree.iter())
                ): raise ValueError()
    except (ValueError, ElementTree.ParseError, zipfile.BadZipFile, RuntimeError, NotImplementedError):
        raise Refused('unavailable')

${nativeWorkDesign}

def write_work_intent(stage, intent, record):
    pending = intent + '-next'
    fd = os.open(pending, os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW, 0o600, dir_fd=stage)
    with os.fdopen(fd, 'w') as stream:
        json.dump(record, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.rename(pending, intent, src_dir_fd=stage, dst_dir_fd=stage)
    os.fsync(stage)

def work_placement(cfg, drive, reply):
    work = cfg['work']
    probe = cfg['mode'] == 'work-probe'
    folder, parts = work_parts(work['folder']), work_parts(work['path'])
    format = work.get('design', 'docx')
    if (len(folder) != 3 or folder[0] != 'Agents' or folder[2] != 'deliverables' or
        format not in ('docx', 'html', 'svg') or not parts[-1].lower().endswith('.' + format) or len(parts) > 8 or
        not re.fullmatch(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}', work['id'])):
        raise Refused('unavailable')

    def hold(stack, fd):
        stack.callback(os.close, fd)
        return fd

    def check_target(target):
        check()
        print(json.dumps({'checkTarget':True}), flush=True)
        if json.loads(sys.stdin.readline()).get('place') is not True: raise Changed()
        check()
        with ExitStack() as verify:
            root = hold(verify, bound_target(cfg))
            current = hold(verify, stage_directory(root, folder))
            if work_identity(current) != work_identity(target): raise Changed()

    with ExitStack() as stack:
        target = hold(stack, stage_directory(drive, folder))
        if work_identity(target) != work['folderIdentity']: raise Changed()
        parent = hold(stack, import_parent(cfg, not probe))
        if work_identity(parent)[0] != work_identity(target)[0]: raise Refused('staging_volume')
        stage_name = 'work-' + work['id']
        if not probe and not cfg.get('workRecovery'):
            try:
                os.mkdir(stage_name, 0o700, dir_fd=parent)
                os.fsync(parent)
            except FileExistsError: pass
        stage = hold(stack, os.open(stage_name, DIR, dir_fd=parent))
        stage_stat = os.fstat(stage)
        if stage_stat.st_uid != os.getuid() or stage_stat.st_mode & 0o077: raise Refused('unavailable')
        lock = hold(stack, os.open('lock', os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW, 0o600, dir_fd=stage))
        fcntl.flock(lock, fcntl.LOCK_EX|fcntl.LOCK_NB)
        scope = {'root':{key:cfg['target'][key] for key in ('root', 'dev', 'ino')}, 'work':work}

        def place(name, prefix, prepare, remaining):
            intent = prefix + 'intent'
            payload_name = prefix + 'payload'
            try: record_fd = os.open(intent, READ, dir_fd=stage)
            except FileNotFoundError: record = None
            else:
                with os.fdopen(record_fd, 'rb') as stream: record = json.loads(stream.read(16384))

            if record is not None:
                if record['scope'] != scope: raise Changed()
                placement = record['placement']
                suffix = record['suffix']
                try: payload = os.open(payload_name, READ, dir_fd=stage)
                except FileNotFoundError:
                    # Rename consumed the staged inode. Absence or replacement is ambiguous.
                    check_target(target)
                    try: placed = hold(stack, os.open(placement['name'], READ, dir_fd=target))
                    except FileNotFoundError: raise Changed()
                    if work_hash(placed, target, placement['name']) != record['facts']: raise Changed()
                    os.fsync(target)
                    os.fsync(stage)
                    return placement
                if work_hash(hold(stack, payload), stage, payload_name) != record['facts']: raise Changed()
                facts = record['facts']
                if probe: return
            else:
                if probe or (cfg.get('workRecovery') and not prefix): return
                if prepare: prepare()
                payload = hold(stack, os.open(payload_name, READ, dir_fd=stage))
                facts = work_hash(payload, stage, payload_name)
                suffix = 1

            stem, extension = os.path.splitext(name)
            for index in range(suffix, 1001):
                candidate = name if index == 1 else stem + ' (' + str(index) + ')' + extension
                placement = dict(facts, name=candidate)
                write_work_intent(stage, intent, {'scope':scope, 'facts':facts, 'placement':placement, 'suffix':index})
                check_target(target)
                if facts['size'] > remaining: raise OSError(errno.EDQUOT, 'no room')
                try: exclusive_rename(stage, payload_name, target, candidate)
                except OSError as error:
                    if error.errno not in (errno.EEXIST, errno.ENOTEMPTY): raise
                    continue
                os.fsync(target)
                os.fsync(stage)
                reply['added'] += 1
                return placement
            raise Refused('unavailable')

        def prepare_source():
            check_target(target)
            output = hold(stack, directory(work['outputRoot']))
            if work_identity(output) != work['outputIdentity']: raise Changed()
            source_parent = hold(stack, stage_directory(output, parts[:-1]))
            source = hold(stack, os.open(parts[-1], READ, dir_fd=source_parent))
            info = os.fstat(source)
            limit = WORK_MAX_BYTES if format == 'docx' else DESIGN_MAX_BYTES
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or not 0 < info.st_size <= limit:
                raise Refused('unavailable')
            # With no committed intent, a payload can only be an interrupted copy.
            try: os.unlink('payload', dir_fd=stage)
            except FileNotFoundError: pass
            copy_file(source, stage, 'payload', identity(info))
            payload = hold(stack, os.open('payload', READ, dir_fd=stage))
            if format == 'docx': validate_work_docx(payload)
            else: prepare_work_preview(stage, payload, format)

        remaining = cfg.get('remaining', WORK_MAX_BYTES * 2)
        placed = place(parts[-1], '', prepare_source, remaining)
        if placed is None: return
        if format != 'docx':
            if reply['added']: remaining -= placed['size']
            # Tie the preview name to the actual editable sibling selected on collision.
            preview = place(placed['name'] + '.png', 'preview-', None, remaining)
            if preview is None: return
            reply['previewPlacement'] = preview
        reply.update(state='completed', placement=placed)
`
