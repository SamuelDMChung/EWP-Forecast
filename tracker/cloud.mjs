import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from '../forecast/config.mjs';
import { getAccessToken } from '../forecast/auth.mjs?v=1.0-p3';
const REST = `${SUPABASE_URL.replace(/\/$/,'')}/rest/v1`;

async function request(path, { method='GET', body, prefer='' }={}) {
  const token=await getAccessToken();
  if (!token) throw new Error('Sign in to Supabase first.');
  const headers = { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization:`Bearer ${token}`, Accept:'application/json' };
  if (body !== undefined) headers['Content-Type']='application/json';
  if (prefer) headers.Prefer=prefer;
  const res=await fetch(`${REST}/${path}`, { method, headers, body:body===undefined ? undefined:JSON.stringify(body), cache:'no-store' });
  const text=await res.text();
  let data;
  try { data=text ? JSON.parse(text):null; } catch { data=text; }
  if (!res.ok) throw new Error(data?.message || data?.details || data?.hint || String(data) || `Supabase request failed: ${res.status}`);
  return data;
}

async function allRows(table, order='created_at.asc') {
  let offset=0, results=[];
  for (;;) {
    const query=new URLSearchParams({select:'*',order,limit:'1000',offset:String(offset)});
    const batch=await request(`${table}?${query}`);
    results.push(...(batch||[]));
    if (!batch || batch.length<1000) return results;
    offset+=1000;
  }
}

export async function loadTrackerCloud() {
  const [projects,workItems,settings,filters]=await Promise.all([
    allRows('projects'),allRows('tracker_work_items'),
    request('tracker_settings?select=*&id=eq.global'),allRows('tracker_saved_filters')
  ]);
  return { projects, workItems, settings:settings?.[0] || {sales:[],assignees:[],tasks:[]}, filters };
}
export function saveTrackerProject(project, workItems, expectedVersion=null) {
  return request('rpc/tracker_save_project',{method:'POST',body:{p_project:project,p_work_items:workItems,p_expected_version:expectedVersion}});
}
export function moveTrackerWorkItem(id,status) {
  return request('rpc/tracker_move_work_item',{method:'POST',body:{p_id:id,p_status:status}});
}
export function deleteTrackerProject(id,version) {
  return request('rpc/tracker_delete_project',{method:'POST',body:{p_id:id,p_expected_version:version}});
}
export function getNextTrackerNumber(yy) {
  return request('rpc/tracker_next_number',{method:'POST',body:{p_yy:yy}});
}
export async function saveTrackerSettings(settings) {
  return request('tracker_settings?on_conflict=id', {method:'POST',body:{id:'global',sales:settings.sales,assignees:settings.assignees,tasks:settings.tasks,updated_at:new Date().toISOString()},prefer:'resolution=merge-duplicates,return=representation'});
}
export async function addTrackerFilter(filter) {
  return request('tracker_saved_filters',{method:'POST',body:{id:filter.id,name:filter.name,search:filter.search,filters:filter.filters,created_at:filter.createdAt},prefer:'return=representation'});
}
export async function removeTrackerFilter(id) {
  return request(`tracker_saved_filters?id=eq.${encodeURIComponent(id)}`,{method:'DELETE'});
}
