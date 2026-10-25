"""Snapshot explicit attachments and eligible task artifact references; never crawl folders."""
import hashlib,json,mimetypes,os,re,stat,tempfile
from pathlib import Path
from urllib.parse import unquote,urlsplit
MAX_BYTES=50*1024*1024
MAX_FILES=64
def references(record):
    content=record.get('content');out=[]
    if record['role']=='user' and isinstance(content,dict):
        for key in ('files','images'):
            for item in content.get(key,[]) or []:
                ref=item if isinstance(item,str) else next((item[k] for k in ('path','filePath','url','src') if isinstance(item.get(k),str)),None) if isinstance(item,dict) else None
                if ref:out.append((ref,'attachment'))
    if record['role']=='assistant' and isinstance(content,str):
        for ref in re.findall(r'\]\(<?((?:/|file://|cindy-media://)[^\n)]*?)>?\)',content):out.append((ref,'artifact_reference'))
    if record['role']=='tool_result' and isinstance(content,dict):
        def visit(v,depth=0):
            if depth>5:return
            if isinstance(v,dict):
                for k,x in v.items():
                    if k in ('cindyPath','output_path','artifact_path','saved_path') and isinstance(x,str):out.append((x,'artifact_reference'))
                    elif isinstance(x,(dict,list)):visit(x,depth+1)
            elif isinstance(v,list):
                for x in v[:MAX_FILES]:visit(x,depth+1)
        visit(content)
    return list(dict.fromkeys(out))
def eligible_path(reference,kind,record,database):
    ref=reference.strip();parsed=urlsplit(ref)
    if parsed.scheme=='cindy-media':
        match=re.fullmatch(r'/([0-9a-f]{64})(\.[a-zA-Z0-9]+)',parsed.path)
        if parsed.netloc!='blobs' or not match:return None,'unsupported_reference'
        digest,ext=match.groups();candidate=Path(database).parent/'cindy-media'/'blobs'/digest[:2]/(digest+ext)
    else:
        if parsed.scheme not in ('','file') or parsed.netloc not in ('','localhost'):return None,'unsupported_reference'
        if parsed.query or parsed.fragment:return None,'unsupported_reference'
        raw=unquote(parsed.path) if parsed.scheme else ref
        raw=re.sub(r':\d+(?::\d+)?$','',raw)
        candidate=Path(raw).expanduser()
        if not candidate.is_absolute():return None,'relative_reference'
        if kind!='attachment':
            if record.get('remote_host_id') or record.get('workspace_kind') not in (None,'local','dialogue'):return None,'remote_reference'
            roots=[Path.home()/d for d in ('Projects','Pictures','Documents','Desktop')]
            if record.get('working_dir'):roots.append(Path(record['working_dir']))
            absolute=Path(os.path.abspath(candidate))
            if not any(absolute==r or r in absolute.parents for r in roots if r.is_absolute()):return None,'outside_artifact_roots'
    candidate=Path(os.path.abspath(candidate))
    if any(x.is_symlink() for x in (candidate,*candidate.parents)):return None,'symlink_reference'
    if candidate.name in ('.env','id_rsa','id_ed25519','credentials','credentials.json') or candidate.suffix in ('.pem','.key') or any(x in candidate.parts for x in ('.ssh','.aws','safe-storage','safeStorage')):return None,'credential_path'
    return candidate,None
def snapshot(reference,kind,record,database,folder,consumer,max_bytes=MAX_BYTES):
    candidate,reason=eligible_path(reference,kind,record,database)
    manifest={'reference':reference,'reference_kind':kind,'status':reason or 'pending','snapshot_semantics':'bytes available at capture time; not proof of original creation bytes'}
    temp=None
    try:
        if candidate:
            try:
                fd=os.open(candidate,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
                with os.fdopen(fd,'rb') as src:
                    before=os.fstat(src.fileno())
                    if not stat.S_ISREG(before.st_mode):manifest['status']='not_regular_file'
                    elif before.st_size>max_bytes:manifest.update(status='size_limit',byte_size=before.st_size,max_bytes=max_bytes)
                    else:
                        sha=hashlib.sha256();size=0
                        with tempfile.NamedTemporaryFile(dir=folder,prefix='snapshot-',delete=False) as out:
                            temp=Path(out.name);os.chmod(temp,0o600)
                            while chunk:=src.read(1024*1024):
                                size+=len(chunk)
                                if size>max_bytes:break
                                sha.update(chunk);out.write(chunk)
                        after=os.fstat(src.fileno())
                        if size>max_bytes:manifest.update(status='size_limit',byte_size=size,max_bytes=max_bytes)
                        elif (before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns):manifest['status']='changed_during_read'
                        else:manifest.update(status='archived',byte_size=size,sha256=sha.hexdigest(),media_type=mimetypes.guess_type(str(candidate))[0] or 'application/octet-stream')
            except FileNotFoundError:manifest['status']='missing'
            except PermissionError:manifest['status']='permission_denied'
            except OSError:manifest['status']='file_read_failed'
        identity=hashlib.sha256(json.dumps(manifest,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        result=consumer(identity,manifest,temp if manifest['status']=='archived' else None)
        return manifest,result
    finally:
        if temp:temp.unlink(missing_ok=True)
