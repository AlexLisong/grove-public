declare module 'pdf-parse/lib/pdf-parse.js' {
  export default function parsePdf(buffer:Buffer,options?:{max?:number}):Promise<{text:string;numpages:number;info:unknown}>;
}
