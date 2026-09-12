#!/usr/bin/env python3
"""Launch Grove locally with isolated development configuration (never prints secrets)."""
import json,os,secrets,subprocess,sys
from pathlib import Path
root=Path(__file__).resolve().parents[1]
config=root/'.data'/'dev-env.json';config.parent.mkdir(exist_ok=True)
if not config.exists():
 values={'DATABASE_URL':'postgres://grove:grove_local_only@127.0.0.1:55432/grove','APP_URL':'http://localhost:5173','PORT':'4310','NODE_ENV':'development','SESSION_SECRET':secrets.token_hex(32),'APP_ENCRYPTION_KEY':secrets.token_hex(32),'REGISTRATION_CODE':secrets.token_urlsafe(24)}
 fd=os.open(config,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
 with os.fdopen(fd,'w') as f:json.dump(values,f)
env=dict(os.environ);env.update(json.loads(config.read_text()))
sys.exit(subprocess.call(sys.argv[1:] or ['npm','run','dev'],cwd=root,env=env))
