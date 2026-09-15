import { beforeEach, describe, expect, it, vi } from 'vitest';
const state=vi.hoisted(()=>({load:vi.fn(),bookings:vi.fn().mockResolvedValue([])}));
vi.mock('./cityAccess',async original=>({...await original<object>(),loadCityAccess:state.load}));
vi.mock('./db',async original=>({...await original<object>(),getMultiparkBookings:state.bookings,getUserPermissionOverrides:async()=>({}),getProjects:async()=>[{id:50},{id:65},{id:49}],getEmployeeByUserId:async()=>({employee:{id:7,projectId:null}})}));
import {appRouter} from './routers';
const caller=(role='extra')=>appRouter.createCaller({user:{id:123,role},req:{headers:{}},res:{}} as any);
beforeEach(()=>{state.load.mockReset();state.load.mockResolvedValue({all:false,defaultCityId:50,cityName:'Porto',cityIds:[50],projectIds:[50,65],missingCostCenter:false});});
describe('cidades no servidor',()=>{
 it('filtra os projetos mesmo para administradores',async()=>expect(await caller('admin').projects.list()).toEqual([{id:50},{id:65}]));
 it('a consulta sem filtros recebe Porto antes de executar',async()=>{await caller('admin').multipark.bookings();expect(state.bookings).toHaveBeenCalledWith(expect.objectContaining({city:'Porto'}));});
 it('rejeita um filtro de outra cidade enviado diretamente à API',async()=>{
  await expect(caller('admin').multipark.bookings({projectId:49})).rejects.toMatchObject({code:'FORBIDDEN'});
 });
 it('sem centro bloqueia operações mas permite perfil e aviso',async()=>{
  state.load.mockResolvedValue({all:false,defaultCityId:null,cityIds:[],projectIds:[],missingCostCenter:true});
  await expect(caller('super_admin').multipark.bookings()).rejects.toMatchObject({code:'FORBIDDEN'});
  expect(await caller().projects.list()).toEqual([]);
  expect(await caller().permissions.myCityAccess()).toMatchObject({missingCostCenter:true});
  expect(await caller().rh.me()).toMatchObject({employee:{id:7}});
 });
});
