// scripts/_supabase-stub.mjs — a PostgREST query builder over in-memory tables.
//
// Stands in for @supabase/supabase-js so an API handler can be tested without a
// database or a network. Tables come from globalThis.__db. The chain is lazy and
// only runs on await, exactly as the real client behaves — a builder that ran
// eagerly would hide bugs in how a handler composes its filters.
export function createClient(){
  return {
    from(table){
      const q = { table, head:false, count:null, filters:[], order:null, max:null };
      const builder = {
        select(cols, opts){ q.head = !!opts?.head; q.count = opts?.count || null; return builder; },
        in(col, vals){ q.filters.push(r => vals.includes(r[col])); return builder; },
        gt(col, val){ q.filters.push(r => (r[col] ?? 0) > val); return builder; },
        eq(col, val){ q.filters.push(r => r[col] === val); return builder; },
        order(col, opts){ q.order = { col, asc: opts?.ascending !== false }; return builder; },
        limit(n){ q.max = n; return builder; },
        then(resolve, reject){
          try {
            let rows = (globalThis.__db?.[q.table] || []).filter(r => q.filters.every(f => f(r)));
            if(q.order){
              const { col, asc } = q.order;
              rows = [...rows].sort((a, b) => {
                const x = a[col] ?? 0, y = b[col] ?? 0;
                return (asc ? 1 : -1) * (x < y ? -1 : x > y ? 1 : 0);
              });
            }
            const count = rows.length;
            if(q.max != null) rows = rows.slice(0, q.max);
            resolve({ data: q.head ? null : rows, error: null, count: q.count ? count : null });
          } catch(err){ reject(err); }
        }
      };
      return builder;
    }
  };
}
