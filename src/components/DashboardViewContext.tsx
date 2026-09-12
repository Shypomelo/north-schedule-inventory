'use client';
import {createContext,useContext,useEffect,useRef,useState, useCallback} from 'react';
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
 const [open,setOpen]=useState(false);
 const root=useRef<HTMLDivElement>(null);
 useEffect(()=>{
  if(!open)return;
  const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};
  document.addEventListener('pointerdown',outside);
  return()=>document.removeEventListener('pointerdown',outside);
 },[open]);
 if(loading)return <p className="text-xs">載入視角…</p>;
 if(error)return <p role="alert" className="break-words text-xs text-danger">{error}</p>;
 const label=(key:DashboardViewKey)=>({ENGINEERING:'工程',PROJECT_MANAGEMENT:'專案管理',DESIGN:'設計'} as const)[key];
 if(allowed.length<=1)return <p className="mb-2 text-xs font-semibold text-[var(--sidebar-muted)]">{selected?label(selected.key):'未指派啟用視角'}</p>;
 const choose=(key:DashboardViewKey)=>{select(key);setOpen(false);};
 const move=(offset:number)=>{const index=Math.max(0,allowed.findIndex(view=>view.key===selected?.key));choose(allowed[(index+offset+allowed.length)%allowed.length].key);};
 return <div ref={root} className="relative mb-2">
  <button type="button" aria-label="工作視角" aria-haspopup="listbox" aria-expanded={open} onClick={()=>setOpen(value=>!value)} onKeyDown={event=>{if(event.key==='Escape'){setOpen(false);event.preventDefault();}else if(event.key==='ArrowDown'){move(1);event.preventDefault();}else if(event.key==='ArrowUp'){move(-1);event.preventDefault();}}} className="flex min-h-11 w-full items-center justify-between rounded-lg border border-[var(--sidebar-border)] bg-[var(--sidebar-hover)] px-3 text-left text-sm font-semibold text-[var(--sidebar-text)] outline-none hover:bg-[var(--sidebar-active)] focus:ring-2 focus:ring-[var(--sidebar-brand)]">
   <span>{selected?label(selected.key):'選擇工作視角'}</span><span aria-hidden>⌄</span>
  </button>
  {open&&<div role="listbox" aria-label="工作視角選項" className="absolute inset-x-0 top-full z-50 mt-1 rounded-lg border border-[var(--sidebar-border)] bg-[var(--bg-sidebar)] p-1 shadow-xl">
   {allowed.map(view=><button type="button" role="option" aria-selected={selected?.key===view.key} key={view.id} onClick={()=>choose(view.key)} className={`min-h-11 w-full rounded-md px-3 text-left text-sm hover:bg-[var(--sidebar-hover)] ${selected?.key===view.key?'bg-[var(--sidebar-active)] text-[var(--sidebar-brand)]':'text-[var(--sidebar-text)]'}`}>{label(view.key)}</button>)}
  </div>}
 </div>;
}
