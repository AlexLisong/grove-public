// Shared copies carry authored text, never live links into the source workspace.
// The structured document retains its formatting; reference blocks become labels.
export function detachDocumentReferences(node:any,depth=0):any {
 if(!node||typeof node!=='object'||depth>64)return null;
 if(node.type==='entityMention')return {type:'text',text:`@${String(node.attrs?.label||'Item')}`};
 if(node.type==='tableReference')return {type:'paragraph',content:[{type:'text',text:`Table: ${String(node.attrs?.label||'Table')} (connect a table in your workspace)`}]};
 if(node.type==='rawMarkdown')return {...node,attrs:{...node.attrs,markdown:detachMarkdownReferences(String(node.attrs?.markdown||''))}};
 return {...node,...(Array.isArray(node.marks)?{marks:node.marks.filter((mark:any)=>mark?.type!=='link'||!/^\/library\?open=[0-9a-f-]{36}(?:&embed=table)?$/i.test(mark.attrs?.href||''))}:{}),...(Array.isArray(node.content)?{content:node.content.map((child:any)=>detachDocumentReferences(child,depth+1)).filter(Boolean)}:{})};
}
export function detachMarkdownReferences(content:string){
 return content.replace(/\[((?:\\.|[^\]\\\n])*)\]\(\/library\?open=[0-9a-f-]{36}(?:&embed=table)?\)/gi,'$1');
}
