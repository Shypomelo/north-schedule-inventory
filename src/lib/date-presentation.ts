// Calendar age may establish overdue, NEVER establish actual completion.
export function presentBusinessDate({planned,actual,completed=false,today}:{planned?:string|null;actual?:string|null;completed?:boolean;today:string}) {
 const day=(value:string)=>value.slice(0,10).replace(/-/g,'/');
 if(actual)return {label:'實際 '+day(actual),kind:'actual' as const,overdue:false,date:actual};
 if(completed)return {label:planned?'已完成 · 原預計 '+day(planned):'已完成',kind:'completed' as const,overdue:false,date:null};
 const overdue=!!planned&&planned.slice(0,10)<today;
 return {label:planned?'預計 '+day(planned)+(overdue?' · 逾期':''):'未排程',kind:'planned' as const,overdue,date:planned||null};
}
