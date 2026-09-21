import { userSortKeys, type UserSortKey } from '../../shared/analytics'
export const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
export const validEnvironment = (value: unknown): value is string => typeof value === 'string' && ['all','production','development','test'].includes(value)
export type AnalyticsState = { from: string; to: string; environment: string; appVersion: string; page: number; limit: number; search: string; sort: UserSortKey | ''; direction: 'asc' | 'desc'; user: string }
export function validDates(from: string, to: string) {
  return [from,to].every(v => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v) && from <= to && to <= today() && Date.parse(to)-Date.parse(from) <= 399*86400000
}
export function readAnalyticsState(query: string): AnalyticsState {
  const q = new URLSearchParams(query)
  let from = q.get('from') ?? new Date(Date.now()+8*3600000-29*86400000).toISOString().slice(0,10), to = q.get('to') ?? today()
  if (!validDates(from,to)) { to=today(); from=new Date(Date.parse(to)-29*86400000).toISOString().slice(0,10) }
  const limit = [10,25,50,100].includes(Number(q.get('limit'))) ? Number(q.get('limit')) : 10
  const sort = q.get('sort')
  return {from,to,environment:validEnvironment(q.get('environment'))?q.get('environment')!:'',appVersion:/^[0-9][a-zA-Z0-9.+-]{0,63}$/.test(q.get('appVersion')??'')?q.get('appVersion')!:'',page:Math.max(1,Math.min(Math.floor(100000/limit)+1,Number(q.get('page'))||1))|0,limit,search:(q.get('search')??'').slice(0,80),sort:userSortKeys.includes(sort as UserSortKey)?sort as UserSortKey:'',direction:q.get('direction')==='asc'?'asc':'desc',user:/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(q.get('user')??'')?q.get('user')!:''}
}
export function analyticsQuery(state: AnalyticsState) {
  const q = new URLSearchParams({from:state.from,to:state.to,environment:state.environment,limit:String(state.limit)})
  for (const key of ['appVersion','search','sort','user'] as const) if(state[key])q.set(key,state[key])
  if(state.sort)q.set('direction',state.direction)
  if(state.page>1)q.set('page',String(state.page))
  return q.toString()
}
