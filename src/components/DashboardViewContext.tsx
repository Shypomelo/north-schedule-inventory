'use client';
import {createContext,useContext,useEffect,useState, useCallback} from 'react';
import {useUser} from './UserContext';
import {perspectiveAdapter} from '@/lib/db/perspective-adapter';
import {resolveDashboardViews, type DashboardView, type DashboardViewKey} from '@/lib/dashboard-perspectives';
interface ViewState { allowed:DashboardView[]; selected:DashboardView|null; error:string; loading:boolean; select:(key:DashboardViewKey)=>void; reload:()=>void }
const Context=createContext<ViewState>({allowed:[],selected:null,error:'',loading:true,select:()=>{},reload:()=>{}});
export const useDashboardView=()=>useContext(Context);
export function DashboardViewProvider({children}:{children:React.ReactNode}) {
  const {currentUser}=useUser();
  const [state,setState]=useState<{memberId:string;allowed:DashboardView[];selected:DashboardView|null;error:string;loading:boolean}>({memberId:'',allowed:[],selected:null,error:'',loading:true});
  const [revision,setRevision]=useState(0);
  const reload=useCallback(()=>setRevision(v=>v+1),[]);
  useEffect(()=>{
    let live=true;
    if(!currentUser) {setState({memberId:'',allowed:[],selected:null,error:'',loading:false});return;}
    setState({memberId:currentUser.id,allowed:[],selected:null,error:'',loading:true});
    Promise.all([perspectiveAdapter.getDashboardViews(),perspectiveAdapter.getMemberDashboardViews(currentUser.id)]).then(([views,rows])=>{
      if(!live)return;
      const {allowed,defaultView}=resolveDashboardViews(currentUser,views,rows);
      setState({memberId:currentUser.id,allowed,selected:defaultView,error:'',loading:false});
    }).catch(()=>{if(live)setState({memberId:currentUser.id,allowed:[],selected:null,error:'工作視角無法載入；請確認測試環境已套用 candidate migration。',loading:false});});
    return ()=>{live=false;};
  },[currentUser,revision]);
  // In-memory session preference only. Never writes membership/default/role/group.
  const select=(key:DashboardViewKey)=>setState(previous=>({...previous,selected:previous.allowed.find(view=>view.key===key)??previous.selected}));
  const visible=state.memberId===currentUser?.id?state:{allowed:[],selected:null,error:'',loading:!!currentUser};
  return <Context.Provider value={{...visible,select,reload}}>{children}</Context.Provider>;
}
export function DashboardViewSelector() {
 const {allowed,selected,select,error,loading}=useDashboardView();
 if(loading)return <p className="text-xs">載入視角…</p>;
 if(error)return <p role="alert" className="break-words text-xs text-danger">{error}</p>;
 const label=(key:DashboardViewKey)=>({ENGINEERING:'工程',PROJECT_MANAGEMENT:'專案管理',DESIGN:'設計'} as const)[key];
 if(allowed.length<=1)return <p className="mb-2 text-xs font-semibold text-[var(--sidebar-muted)]">{selected?label(selected.key):'未指派啟用視角'}</p>;
 return <label className="mb-2 block"><span className="sr-only">工作視角</span><select aria-label="工作視角" className="min-h-11 w-full min-w-0 rounded-lg border border-[var(--sidebar-border)] bg-[var(--sidebar-hover)] px-3 text-sm font-semibold text-[var(--sidebar-text)] outline-none transition hover:bg-[var(--sidebar-active)] focus:ring-2 focus:ring-[var(--sidebar-brand)]" value={selected?.key||''} onChange={e=>select(e.target.value as DashboardViewKey)}>{allowed.map(view=><option key={view.id} value={view.key}>{label(view.key)}</option>)}</select></label>;
}
