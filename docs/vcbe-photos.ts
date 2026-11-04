// Edge function vcbe-photos (04/11/2026): admin photo gallery of the app ("Photos" section).
// Actions (admin password from vcbe_admin_config, like admin-write):
//   list                                   -> all photos (published or not)
//   add    {title, file_base64, content_type, file_name, width?, height?} -> upload to public bucket vcbe-photos + row in vcbe_photos
//   delete {id}                            -> removes row and file
//   rename {id, title}                     -> changes the title
// The public app reads vcbe_photos directly with the anon key (published = true).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const CORS={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"*","Access-Control-Allow-Methods":"POST,OPTIONS"};
const SB_URL=Deno.env.get('SUPABASE_URL')!;
const SB_KEY=(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||Deno.env.get('SUPABASE_SECRET_KEYS')||'');
const BUCKET='vcbe-photos';
const OK_TYPES=['image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif'];
const json=(o:any,status=200)=>new Response(JSON.stringify(o),{status,headers:{...CORS,'Content-Type':'application/json'}});

Deno.serve(async(req)=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:CORS});
  let body:any={};try{body=await req.json();}catch{}
  const sb=createClient(SB_URL,SB_KEY);
  let ADMIN_PW='';
  try{const{data:cfg}=await sb.from('vcbe_admin_config').select('value').eq('key','admin_password').single();ADMIN_PW=String(cfg?.value||'').trim();}catch{}
  const pw=String(body.password||'').trim();
  if(!ADMIN_PW||pw!==ADMIN_PW)return json({error:'unauthorized'},401);
  const action=String(body.action||'');

  if(action==='list'){
    const{data,error}=await sb.from('vcbe_photos').select('*').order('sort_order').order('created_at',{ascending:false});
    return json(error?{error:error.message}:{ok:true,photos:data||[]});
  }
  if(action==='add'){
    const title=String(body.title||'').trim();
    if(!title)return json({error:'title_required'});
    if(!body.file_base64)return json({error:'file_required'});
    const ct=String(body.content_type||'image/jpeg').toLowerCase();
    if(!OK_TYPES.includes(ct))return json({error:'not_an_image: '+ct});
    let buf:Uint8Array;
    try{buf=Uint8Array.from(atob(String(body.file_base64)),c=>c.charCodeAt(0));}catch{return json({error:'bad_file'});}
    const ext=(ct.split('/')[1]||'jpg').replace('jpeg','jpg');
    const base=String(body.file_name||'photo').replace(/\.[^.]+$/,'').replace(/[^a-z0-9_-]+/gi,'_').slice(0,60)||'photo';
    const path=`${Date.now()}_${base}.${ext}`;
    const up=await sb.storage.from(BUCKET).upload(path,buf,{contentType:ct,upsert:false});
    if(up.error)return json({error:'upload_failed: '+up.error.message});
    const{data:pub}=sb.storage.from(BUCKET).getPublicUrl(path);
    const w=Number(body.width)||null,h=Number(body.height)||null;
    const{data,error}=await sb.from('vcbe_photos').insert({title,url:pub.publicUrl,storage_path:path,width:w,height:h}).select().single();
    if(error){await sb.storage.from(BUCKET).remove([path]);return json({error:'save_failed: '+error.message});}
    return json({ok:true,photo:data});
  }
  if(action==='rename'){
    const title=String(body.title||'').trim();
    if(!body.id||!title)return json({error:'id_and_title_required'});
    const{data,error}=await sb.from('vcbe_photos').update({title}).eq('id',body.id).select().single();
    return json(error?{error:error.message}:{ok:true,photo:data});
  }
  if(action==='delete'){
    const{data:row}=await sb.from('vcbe_photos').select('storage_path').eq('id',body.id).maybeSingle();
    if(row?.storage_path)await sb.storage.from(BUCKET).remove([row.storage_path]);
    const{error}=await sb.from('vcbe_photos').delete().eq('id',body.id);
    return json(error?{error:error.message}:{ok:true});
  }
  return json({error:'unknown action'});
});
