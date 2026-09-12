import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({plugins:[react()],server:{port:5173,proxy:{'/api':'http://127.0.0.1:4310','/mcp':'http://127.0.0.1:4310','/oauth':'http://127.0.0.1:4310','/.well-known':'http://127.0.0.1:4310','/r':'http://127.0.0.1:4310'}},build:{outDir:'dist'}});
