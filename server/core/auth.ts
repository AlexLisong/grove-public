import {clientRateKey} from './rate-limit.js';
import {scrypt as scryptCallback, randomBytes} from 'node:crypto';
import {promisify} from 'node:util';
import {Router, type Request, type RequestHandler, type Response} from 'express';
import rateLimit from 'express-rate-limit';
import {z} from 'zod';
import type {Role, Session, Workspace} from '../../shared/types.js';
import {query, withTransaction} from './db.js';
import {constantEqual, hashToken, httpError, randomToken} from './security.js';
import {runWithAccess} from './access.js';

export interface AuthContext {userId: string; workspaceId: string; role: Role; sessionId?: string; scopes?: string[]; tokenId?: string;itemOnly?:boolean}
declare global {namespace Express {interface Request {auth: AuthContext; csrfToken?: string; authResolved?: boolean}}}
const scrypt = promisify(scryptCallback);
const cookieName = 'grove_session';
const uuid = z.uuid();
export const TOKEN_SCOPES = ['workspace:read','workspace:write','ai:run','publish:write','connections:read','files:read','files:write','research:read','analytics:read'] as const;
const tokenScopes = z.array(z.enum(TOKEN_SCOPES)).min(1).max(TOKEN_SCOPES.length);
const userInput = z.object({name: z.string().trim().min(1).max(100), email: z.email().max(254).transform(v => v.toLowerCase()), password: z.string().min(12).max(200), code: z.string().min(1).max(300)}).strict();
const loginInput = z.object({email: z.email().max(254).transform(v => v.toLowerCase()), password: z.string().min(1).max(200)}).strict();
const workspaceInput = z.object({name: z.string().trim().min(1).max(100)}).strict();
const roleInput = z.enum(['admin','editor','viewer']);
const sessionOptions = () => ({httpOnly: true, sameSite: 'lax' as const, secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 30 * 24 * 60 * 60 * 1000});

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64) as Buffer;
  return `scrypt:${salt}:${derived.toString('hex')}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [algorithm, salt, expected] = stored.split(':');
  if (algorithm !== 'scrypt' || !salt || !expected) return false;
  const derived = await scrypt(password, salt, 64) as Buffer;
  return constantEqual(derived.toString('hex'), expected);
}

export async function assertAccess(workspaceId: string, userId: string): Promise<Role> {
  if (!uuid.safeParse(workspaceId).success) throw httpError(400, 'Invalid workspace.', 'INVALID_WORKSPACE');
  const [membership] = await query<{role: Role}>('SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2', [workspaceId,userId]);
  if (!membership) throw httpError(403, 'You do not have access to this workspace.', 'WORKSPACE_ACCESS');
  return membership.role;
}

function cookieFromRequest(req: Request): string | undefined {
  if (typeof req.cookies?.[cookieName] === 'string') return req.cookies[cookieName];
  const entry = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(`${cookieName}=`));
  if (!entry) return undefined;
  try {return decodeURIComponent(entry.slice(cookieName.length + 1));} catch {return undefined;}
}

export async function authenticateRequest(req: Request): Promise<AuthContext | undefined> {
  if (req.authResolved) return req.auth;
  req.authResolved = true;
  const authorization = req.get('authorization');
  if (authorization) {
    const token = /^Bearer ([A-Za-z0-9_-]{30,200})$/i.exec(authorization)?.[1];
    if (!token) throw httpError(401, 'A valid bearer token is required.', 'TOKEN_INVALID');
    const [record] = await query('SELECT t.*,m.role,m.item_only FROM api_tokens t JOIN memberships m ON m.workspace_id=t.workspace_id AND m.user_id=t.user_id WHERE t.token_hash=$1', [hashToken(token)]);
    if (!record) throw httpError(401, 'This API token is invalid or revoked.', 'TOKEN_INVALID');
    const chosen = req.get('x-workspace-id');
    if (chosen && chosen !== record.workspace_id) throw httpError(403, 'This API token belongs to a different workspace.', 'TOKEN_WORKSPACE');
    req.auth = {userId: record.user_id,workspaceId: record.workspace_id,role: record.role,scopes: record.scopes,tokenId: record.id,itemOnly:record.item_only};
    await query('UPDATE api_tokens SET last_used_at=now() WHERE id=$1 AND (last_used_at IS NULL OR last_used_at < now()-interval \'5 minutes\')', [record.id]);
    return req.auth;
  }
  const cookie = cookieFromRequest(req);
  if (!cookie || !/^[A-Za-z0-9_-]{43}$/.test(cookie)) return;
  const [session] = await query('SELECT id,user_id,csrf_token FROM sessions WHERE token_hash=$1 AND expires_at>now()', [hashToken(cookie)]);
  if (!session) return;
  const chosen = req.get('x-workspace-id');
  let workspaceId: string, role: Role;
  if (chosen) {workspaceId = chosen; role = await assertAccess(chosen,session.user_id);}
  else {
    const [membership] = await query('SELECT workspace_id,role FROM memberships WHERE user_id=$1 ORDER BY CASE role WHEN \'owner\' THEN 0 ELSE 1 END,created_at,workspace_id LIMIT 1', [session.user_id]);
    if (!membership) return;
    workspaceId = membership.workspace_id; role = membership.role;
  }
  const [membershipScope]=await query('SELECT item_only FROM memberships WHERE workspace_id=$1 AND user_id=$2',[workspaceId,session.user_id]);
  req.auth = {userId: session.user_id,workspaceId,role,sessionId: session.id,itemOnly:membershipScope?.item_only};
  req.csrfToken = session.csrf_token;
  return req.auth;
}

export const requireAuth: RequestHandler = async (req,res,next) => {
  try {
    if (!await authenticateRequest(req)) throw httpError(401, 'Please sign in.', 'AUTH_REQUIRED');
    if(req.auth.itemOnly && !/^\/api\/(?:auth\/(?:me|logout|profile|password)|entities(?:\/|$)|files\/|comments\/|public\/|(?:entity-)?invitations\/accept|catalog$|workspaces$|preferences(?:\/|$)|reader\/)/.test(req.originalUrl.split('?')[0])) throw httpError(403,'This invitation grants access only to shared items.','ITEM_GUEST');
    runWithAccess(req.auth,()=>next());
  } catch (error) {next(error);}
};
export const requireEditor: RequestHandler = (req,res,next) => {
  if (!req.auth) return next(httpError(401, 'Please sign in.', 'AUTH_REQUIRED'));
  if (req.auth.role === 'viewer') return next(httpError(403, 'Editor access is required.', 'EDITOR_REQUIRED'));
  next();
};
export const requireAdmin: RequestHandler = (req,res,next) => {
  if (!req.auth || !['owner','admin'].includes(req.auth.role)) return next(httpError(403, 'Workspace administrator access is required.', 'ADMIN_REQUIRED'));
  next();
};
export function assertScope(req: Request, scope: string) {
  if (!req.auth) throw httpError(401, 'Please sign in.', 'AUTH_REQUIRED');
  const scopes = req.auth.scopes;
  if (!scopes) return;
  // Granular scopes must be granted explicitly. Workspace write implies only
  // workspace read, never publishing or AI execution.
  if (!scopes.includes(scope) && !(scope === 'workspace:read' && scopes.includes('workspace:write')) && !(scope === 'files:read' && scopes.includes('files:write'))) throw httpError(403, `The API token requires ${scope}.`, 'TOKEN_SCOPE');
}
export const requireScope = (scope: string): RequestHandler => (req,res,next) => {try {assertScope(req,scope);next();} catch (error) {next(error);}};
const sessionOnly: RequestHandler = (req,res,next) => req.auth?.scopes ? next(httpError(403, 'Use a signed-in browser for account and access management.', 'SESSION_REQUIRED')) : next();

export const csrfProtection: RequestHandler = async (req,res,next) => {
  try {
    if (['GET','HEAD','OPTIONS'].includes(req.method)) return next();
    const pathname = req.originalUrl.split('?')[0];
    const origin = req.get('origin');
    const allowedOrigin = process.env.APP_URL ? new URL(process.env.APP_URL).origin : undefined;
    if (/^\/api\/webhooks\/[a-z0-9_-]+\/?$/i.test(pathname)) return next(); // Provider router verifies signatures.
    if (origin && allowedOrigin && origin !== allowedOrigin) throw httpError(403, 'This origin is not allowed.', 'ORIGIN_INVALID');
    if (/^\/api\/auth\/(login|register)\/?$/.test(pathname)) return next();
    const auth = await authenticateRequest(req);
    if (!auth) throw httpError(401, 'Please sign in.', 'AUTH_REQUIRED');
    if (auth.scopes) return next();
    const supplied = req.get('x-csrf-token');
    if (!supplied || !req.csrfToken || !constantEqual(supplied, req.csrfToken)) throw httpError(403, 'Refresh the page and try again.', 'CSRF_INVALID');
    next();
  } catch (error) {next(error);}
};

async function workspacesFor(userId: string): Promise<Workspace[]> {
  return query('SELECT w.id,w.name,m.role,m.item_only AS "itemOnly" FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE m.user_id=$1 ORDER BY CASE m.role WHEN \'owner\' THEN 0 ELSE 1 END,m.created_at,w.id', [userId]);
}
async function sessionBody(userId: string, workspaceId: string | undefined, csrfToken: string): Promise<Session> {
  const [user] = await query<any>('SELECT id,email,name FROM users WHERE id=$1', [userId]);
  const workspaces = await workspacesFor(userId);
  const workspace = workspaces.find(w => w.id === workspaceId) || workspaces[0];
  if (!workspace) throw httpError(403, 'This account has no workspace.', 'NO_WORKSPACE');
  return {user,workspaces,workspace,csrfToken};
}
async function createSession(res: Response, userId: string, workspaceId?: string) {
  const token = randomToken(), csrfToken = randomToken();
  await query('DELETE FROM sessions WHERE user_id=$1 AND expires_at<now()', [userId]);
  await query('INSERT INTO sessions(user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval \'30 days\')', [userId,hashToken(token),csrfToken]);
  res.cookie(cookieName, token, sessionOptions());
  return sessionBody(userId,workspaceId,csrfToken);
}

export const authRouter = Router();
const loginLimiter = rateLimit({keyGenerator:clientRateKey,windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false, message: {error: 'Too many sign-in attempts. Try again in 15 minutes.', code: 'RATE_LIMIT'}});
authRouter.get('/auth/config', (req,res) => res.json({registrationRequiresCode:true}));
authRouter.post('/auth/register', loginLimiter, async (req,res) => {
  const input = userInput.parse(req.body);
  const registrationCode = process.env.REGISTRATION_CODE;
  const useCode = !!registrationCode && constantEqual(input.code,registrationCode);
  const passwordHash = await hashPassword(input.password);
  try {
    const result = await withTransaction(async client => {
      let invitation = !useCode ? (await client.query('SELECT * FROM invitations WHERE token_hash=$1 AND accepted_at IS NULL AND expires_at>now() FOR UPDATE', [hashToken(input.code)])).rows[0] : null;
      if(!useCode && !invitation) invitation=(await client.query("SELECT *, 'viewer' AS role FROM entity_invitations WHERE token_hash=$1 AND accepted_at IS NULL AND expires_at>now() FOR UPDATE",[hashToken(input.code)])).rows[0];
      if (!useCode && (!invitation || invitation.email !== input.email)) throw httpError(403, 'A valid private invitation code is required.', 'INVITATION_REQUIRED');
      const user = (await client.query('INSERT INTO users(email,name,password_hash) VALUES($1,$2,$3) RETURNING id', [input.email,input.name,passwordHash])).rows[0];
      const workspace = invitation ? {id: invitation.workspace_id} : (await client.query('INSERT INTO workspaces(name) VALUES($1) RETURNING id', [`${input.name}'s workspace`])).rows[0];
      await client.query('INSERT INTO memberships(workspace_id,user_id,role,item_only) VALUES($1,$2,$3,$4)', [workspace.id,user.id,invitation?.role || 'owner',!!invitation?.entity_id]);
      if (invitation?.entity_id) {
        await client.query('INSERT INTO entity_acl(entity_id,workspace_id,user_id,permission) VALUES($1,$2,$3,$4)',[invitation.entity_id,workspace.id,user.id,invitation.permission]);
        await client.query('UPDATE entity_invitations SET accepted_at=now() WHERE id=$1',[invitation.id]);
      } else if(invitation) await client.query('UPDATE invitations SET accepted_at=now() WHERE id=$1', [invitation.id]);
      return {userId:user.id,workspaceId:workspace.id};
    });
    res.status(201).json(await createSession(res,result.userId,result.workspaceId));
  } catch (error: any) {
    if (error.code === '23505') throw httpError(409, 'An account with this email already exists. Sign in to continue.', 'EMAIL_EXISTS');
    throw error;
  }
});
authRouter.post('/auth/login', loginLimiter, async (req,res) => {
  const input = loginInput.parse(req.body);
  const [user] = await query('SELECT id,password_hash FROM users WHERE email=$1', [input.email]);
  // Exercise the same password KDF for unknown accounts to reduce enumeration.
  const valid = await verifyPassword(input.password,user?.password_hash || `scrypt:00000000000000000000000000000000:${'0'.repeat(128)}`);
  if (!user || !valid) throw httpError(401, 'Email or password is incorrect.', 'LOGIN_INVALID');
  res.json(await createSession(res,user.id));
});
authRouter.get('/auth/me', requireAuth, async (req,res) => {
  const body=await sessionBody(req.auth!.userId,req.auth!.workspaceId,req.csrfToken || '');
  if(req.auth.scopes) body.workspaces=[body.workspace];
  res.set('Cache-Control','no-store').json(body);
});
authRouter.post('/auth/logout', requireAuth, sessionOnly, async (req,res) => {
  await query('DELETE FROM sessions WHERE id=$1 AND user_id=$2', [req.auth!.sessionId,req.auth!.userId]);
  res.clearCookie(cookieName,{...sessionOptions(),maxAge: undefined}).json({ok:true});
});
authRouter.patch('/auth/profile', requireAuth, sessionOnly, async (req,res) => {
  const input = z.object({name:z.string().trim().min(1).max(100)}).strict().parse(req.body);
  await query('UPDATE users SET name=$1 WHERE id=$2', [input.name,req.auth!.userId]);
  res.json(await sessionBody(req.auth!.userId,req.auth!.workspaceId,req.csrfToken || ''));
});
authRouter.post('/auth/password', requireAuth, sessionOnly, async (req,res) => {
  const input = z.object({currentPassword:z.string().max(200),password:z.string().min(12).max(200)}).strict().parse(req.body);
  const [user] = await query('SELECT password_hash FROM users WHERE id=$1', [req.auth!.userId]);
  if (!await verifyPassword(input.currentPassword,user.password_hash)) throw httpError(403,'Current password is incorrect.');
  await withTransaction(async client => {
    await client.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await hashPassword(input.password),req.auth!.userId]);
    await client.query('DELETE FROM sessions WHERE user_id=$1 AND id<>$2', [req.auth!.userId,req.auth!.sessionId]);
  });
  res.json({ok:true});
});
authRouter.get('/workspaces', requireAuth, sessionOnly, async (req,res) => res.json({workspaces:await workspacesFor(req.auth!.userId)}));
authRouter.post('/workspaces', requireAuth, sessionOnly, async (req,res) => {
  const input = workspaceInput.parse(req.body);
  const workspace = await withTransaction(async client => {
    const {rows:[created]} = await client.query('INSERT INTO workspaces(name) VALUES($1) RETURNING id,name', [input.name]);
    await client.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,\'owner\')', [created.id,req.auth!.userId]);
    return {...created,role:'owner'};
  });
  res.status(201).json({workspace});
});
authRouter.patch('/workspaces/:id', requireAuth, sessionOnly, async (req,res) => {
  const id = uuid.parse(req.params.id), input = workspaceInput.parse(req.body);
  const role = await assertAccess(id,req.auth!.userId);
  if (!['owner','admin'].includes(role)) throw httpError(403,'Workspace administrator access is required.');
  const [workspace] = await query('UPDATE workspaces SET name=$1,updated_at=now() WHERE id=$2 RETURNING id,name', [input.name,id]);
  res.json({workspace:{...workspace,role}});
});
authRouter.get('/workspaces/:id/members', requireAuth, sessionOnly, async (req,res) => {
  const id = uuid.parse(req.params.id); await assertAccess(id,req.auth!.userId);
  const members = await query('SELECT u.id,u.name,u.email,m.role,m.created_at AS "joinedAt" FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 ORDER BY m.created_at', [id]);
  const role = await assertAccess(id,req.auth!.userId);
  const invitations = ['owner','admin'].includes(role) ? await query('SELECT id,email,role,expires_at AS "expiresAt" FROM invitations WHERE workspace_id=$1 AND accepted_at IS NULL AND expires_at>now()', [id]) : [];
  res.json({members,invitations});
});
authRouter.post('/workspaces/:id/invite', requireAuth, sessionOnly, async (req,res) => {
  const id = uuid.parse(req.params.id), role = await assertAccess(id,req.auth!.userId);
  if (!['owner','admin'].includes(role)) throw httpError(403,'Workspace administrator access is required.');
  const input = z.object({email:z.email().max(254).transform(v => v.toLowerCase()),role:roleInput}).strict().parse(req.body);
  if (role === 'admin' && input.role === 'admin') throw httpError(403,'Only the owner can invite another administrator.');
  const token = randomToken();
  await query('INSERT INTO invitations(workspace_id,email,role,token_hash,invited_by,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval \'7 days\')', [id,input.email,input.role,hashToken(token),req.auth!.userId]);
  const url = `${process.env.APP_URL || 'http://localhost:5173'}/invite?token=${token}`;
  res.status(201).json({url,token,expiresInDays:7});
});
authRouter.post(['/invitations/accept','/entity-invitations/accept'], requireAuth, sessionOnly, async (req,res) => {
  const {token} = z.object({token:z.string().min(30).max(200)}).strict().parse(req.body);
  const workspaceId = await withTransaction(async client => {
    let invitation=(await client.query('SELECT i.*,u.email AS account_email FROM invitations i CROSS JOIN users u WHERE i.token_hash=$1 AND i.accepted_at IS NULL AND i.expires_at>now() AND u.id=$2 FOR UPDATE OF i', [hashToken(token),req.auth!.userId])).rows[0];
    if(!invitation) invitation=(await client.query("SELECT i.*,u.email AS account_email,'viewer' AS role FROM entity_invitations i CROSS JOIN users u WHERE i.token_hash=$1 AND i.accepted_at IS NULL AND i.expires_at>now() AND u.id=$2 FOR UPDATE OF i",[hashToken(token),req.auth.userId])).rows[0];
    if (!invitation || invitation.email !== invitation.account_email) throw httpError(403,'This invitation is invalid, expired, or intended for a different email.');
    if(invitation.entity_id) await client.query('INSERT INTO memberships(workspace_id,user_id,role,item_only) VALUES($1,$2,$3,true) ON CONFLICT(workspace_id,user_id) DO NOTHING', [invitation.workspace_id,req.auth!.userId,invitation.role]);
    else await client.query('INSERT INTO memberships(workspace_id,user_id,role,item_only) VALUES($1,$2,$3,false) ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=CASE WHEN memberships.item_only THEN EXCLUDED.role ELSE memberships.role END,item_only=false', [invitation.workspace_id,req.auth!.userId,invitation.role]);
    if(invitation.entity_id) {
      await client.query('INSERT INTO entity_acl(entity_id,workspace_id,user_id,permission) VALUES($1,$2,$3,$4) ON CONFLICT(entity_id,user_id) DO UPDATE SET permission=EXCLUDED.permission',[invitation.entity_id,invitation.workspace_id,req.auth.userId,invitation.permission]);
      await client.query('UPDATE entity_invitations SET accepted_at=now() WHERE id=$1',[invitation.id]);
    } else await client.query('UPDATE invitations SET accepted_at=now() WHERE id=$1', [invitation.id]);
    return invitation.workspace_id;
  });
  res.json(await sessionBody(req.auth!.userId,workspaceId,req.csrfToken || ''));
});
authRouter.patch('/workspaces/:id/members/:userId', requireAuth, sessionOnly, async (req,res) => {
  const id = uuid.parse(req.params.id), userId = uuid.parse(req.params.userId);
  const role = await assertAccess(id,req.auth!.userId), targetRole = await assertAccess(id,userId);
  if (role !== 'owner' || targetRole === 'owner') throw httpError(403,'Only the owner can update other members.');
  const input = z.object({role:roleInput}).strict().parse(req.body);
  await query('UPDATE memberships SET role=$1 WHERE workspace_id=$2 AND user_id=$3', [input.role,id,userId]);
  res.json({ok:true});
});
authRouter.delete('/workspaces/:id/members/:userId', requireAuth, sessionOnly, async (req,res) => {
  const id = uuid.parse(req.params.id), userId = uuid.parse(req.params.userId);
  const role = await assertAccess(id,req.auth!.userId), targetRole = await assertAccess(id,userId);
  if (targetRole === 'owner' || (role !== 'owner' && userId !== req.auth!.userId)) throw httpError(403,'Only the owner can remove other members.');
  await query('DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2', [id,userId]);
  res.json({ok:true});
});
authRouter.delete('/workspaces/:id/invitations/:invitationId', requireAuth, sessionOnly, async (req,res) => {
  const id = uuid.parse(req.params.id); const role = await assertAccess(id,req.auth!.userId);
  if (!['owner','admin'].includes(role)) throw httpError(403,'Workspace administrator access is required.');
  await query('DELETE FROM invitations WHERE workspace_id=$1 AND id=$2', [id,uuid.parse(req.params.invitationId)]);
  res.json({ok:true});
});
authRouter.get('/tokens', requireAuth, sessionOnly, async (req,res) => {
  const tokens = await query('SELECT id,name,scopes,created_at AS "createdAt",last_used_at AS "lastUsedAt" FROM api_tokens WHERE user_id=$1 AND workspace_id=$2 ORDER BY created_at DESC', [req.auth!.userId,req.auth!.workspaceId]);
  res.json({tokens,availableScopes:TOKEN_SCOPES});
});
authRouter.post('/tokens', requireAuth, sessionOnly, async (req,res) => {
  const input = z.object({name:z.string().trim().min(1).max(100),scopes:tokenScopes}).strict().parse(req.body);
  if (req.auth!.role === 'viewer' && input.scopes.some(v => v.endsWith(':write') || v === 'ai:run')) throw httpError(403,'Viewers can create read-only API tokens.');
  const token = `grv_${randomToken()}`;
  const [created] = await query('INSERT INTO api_tokens(workspace_id,user_id,name,token_hash,scopes) VALUES($1,$2,$3,$4,$5) RETURNING id', [req.auth!.workspaceId,req.auth!.userId,input.name,hashToken(token),JSON.stringify([...new Set(input.scopes)])]);
  res.status(201).json({id:created.id,token});
});
authRouter.delete('/tokens/:id', requireAuth, sessionOnly, async (req,res) => {
  await query('DELETE FROM api_tokens WHERE id=$1 AND workspace_id=$2 AND user_id=$3', [uuid.parse(req.params.id),req.auth!.workspaceId,req.auth!.userId]);
  res.json({ok:true});
});
