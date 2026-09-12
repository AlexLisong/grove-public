import {isIP} from 'node:net';
import type {Request} from 'express';
import {ipKeyGenerator} from 'express-rate-limit';

// Azure's trusted proxy may append a client port. Different TCP connections
// from the same address must share a rate-limit bucket.
export function normalizeClientIp(value:string|undefined):string|undefined{
 if(!value)return;
 if(isIP(value))return value;
 const ipv4=value.match(/^([\d.]+):\d+$/);if(ipv4&&isIP(ipv4[1])===4)return ipv4[1];
 const ipv6=value.match(/^\[([^\]]+)\](?::\d+)?$/);if(ipv6&&isIP(ipv6[1])===6)return ipv6[1];
}
export function clientRateKey(req:Pick<Request,'ip'|'socket'>){
 return ipKeyGenerator(normalizeClientIp(req.ip)||normalizeClientIp(req.socket.remoteAddress)||'unknown');
}
