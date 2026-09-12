const stored=await chrome.storage.local.get(['groveUrl','groveWorkspace']);
document.querySelector('#url').value=stored.groveUrl||'';document.querySelector('#workspace').value=stored.groveWorkspace||'';
document.querySelector('#settings').addEventListener('submit',async event=>{
 event.preventDefault();const status=document.querySelector('#status');
 try{
  const url=new URL(document.querySelector('#url').value);if(url.protocol!=='https:'&&url.hostname!=='localhost')throw new Error('Use HTTPS for a hosted Grove app.');
  const allowed=await chrome.permissions.request({origins:[url.origin+'/*']});if(!allowed)throw new Error('Permission was not granted.');
  const token=document.querySelector('#token').value.trim(),workspace=document.querySelector('#workspace').value.trim();
  const response=await fetch(url.origin+'/api/entities?kind=board',{headers:{Authorization:'Bearer '+token,'X-Workspace-Id':workspace}});if(!response.ok)throw new Error('Grove could not verify this token and workspace.');
  await chrome.storage.local.set({groveUrl:url.origin,groveToken:token,groveWorkspace:workspace});document.querySelector('#token').value='';status.textContent='Connected. Capture a page from the Grove toolbar button.';
 }catch(error){status.textContent=error.message;}
});
document.querySelector('#disconnect').addEventListener('click',async()=>{const {groveUrl}=await chrome.storage.local.get('groveUrl');await chrome.storage.local.remove(['groveUrl','groveToken','groveWorkspace']);if(groveUrl)await chrome.permissions.remove({origins:[groveUrl+'/*']});document.querySelector('#status').textContent='Disconnected. Revoke the token in Grove Settings if it is no longer used.';});
