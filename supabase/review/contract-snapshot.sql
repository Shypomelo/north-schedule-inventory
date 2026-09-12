-- Read-only schema contract snapshot for Production/Candidate parity.
SELECT jsonb_build_object(
  'relations', COALESCE((SELECT jsonb_object_agg(k,v ORDER BY k) FROM (
    SELECT n.nspname||'.'||c.relname k,
      jsonb_build_object('kind',c.relkind,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
        'view_definition',CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid,true) END) v
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m')
  ) s),'{}'::jsonb),
  'columns', COALESCE((SELECT jsonb_object_agg(k,v ORDER BY k) FROM (
    SELECT n.nspname||'.'||c.relname||'.'||a.attname k,
      jsonb_build_object('type',pg_catalog.format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,
        'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated) v
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m') AND a.attnum>0 AND NOT a.attisdropped
  ) s),'{}'::jsonb),
  'constraints', COALESCE((SELECT jsonb_object_agg(k,v ORDER BY k) FROM (
    SELECT n.nspname||'.'||c.relname||'.'||con.conname k,
      jsonb_build_object('type',con.contype,'definition',pg_get_constraintdef(con.oid,true),'validated',con.convalidated) v
    FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public'
  ) s),'{}'::jsonb),
  'indexes', COALESCE((SELECT jsonb_object_agg(schemaname||'.'||tablename||'.'||indexname,
      jsonb_build_object('definition',indexdef) ORDER BY schemaname,tablename,indexname)
    FROM pg_indexes WHERE schemaname='public'),'{}'::jsonb),
  'enums', COALESCE((SELECT jsonb_object_agg(k,v ORDER BY k) FROM (
    SELECT n.nspname||'.'||t.typname k,jsonb_agg(e.enumlabel ORDER BY e.enumsortorder) v
    FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_enum e ON e.enumtypid=t.oid
    WHERE n.nspname IN ('public','app_private') GROUP BY n.nspname,t.typname
  ) s),'{}'::jsonb),
  'functions', COALESCE((SELECT jsonb_object_agg(k,v ORDER BY k) FROM (
    SELECT n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' k,
      jsonb_build_object('result',pg_get_function_result(p.oid),'security_definer',p.prosecdef,
        'volatility',p.provolatile,'kind',p.prokind,'language',l.lanname,'definition',pg_get_functiondef(p.oid)) v
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
    WHERE n.nspname IN ('public','app_private')
  ) s),'{}'::jsonb),
  'triggers', COALESCE((SELECT jsonb_object_agg(k,v ORDER BY k) FROM (
    SELECT n.nspname||'.'||c.relname||'.'||t.tgname k,
      jsonb_build_object('definition',pg_get_triggerdef(t.oid,true),'enabled',t.tgenabled) v
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND NOT t.tgisinternal
  ) s),'{}'::jsonb),
  'policies', COALESCE((SELECT jsonb_object_agg(k,v ORDER BY k) FROM (
    SELECT schemaname||'.'||tablename||'.'||policyname k,
      jsonb_build_object('permissive',permissive,'roles',roles,'cmd',cmd,'qual',qual,'with_check',with_check) v
    FROM pg_policies WHERE schemaname='public'
  ) s),'{}'::jsonb),
  'extensions', COALESCE((SELECT jsonb_object_agg(e.extname,jsonb_build_object('schema',n.nspname,'version',e.extversion) ORDER BY e.extname)
    FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace),'{}'::jsonb),
  'table_grants', COALESCE((SELECT jsonb_object_agg(k,v ORDER BY k) FROM (
    SELECT table_schema||'.'||table_name||'.'||grantee k,jsonb_agg(privilege_type ORDER BY privilege_type) v
    FROM information_schema.role_table_grants
    WHERE table_schema='public' AND grantee IN ('anon','authenticated','service_role')
    GROUP BY table_schema,table_name,grantee
  ) s),'{}'::jsonb),
  'function_grants', COALESCE((SELECT jsonb_object_agg(k,v ORDER BY k) FROM (
    SELECT n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||').'||
      COALESCE(r.rolname,'PUBLIC') k,jsonb_agg(x.privilege_type ORDER BY x.privilege_type) v
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) x
    LEFT JOIN pg_roles r ON r.oid=x.grantee
    WHERE n.nspname IN ('public','app_private')
    GROUP BY n.nspname,p.proname,p.oid,r.rolname
  ) s),'{}'::jsonb)
) AS schema_snapshot;
