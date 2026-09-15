import { describe, expect, it } from 'vitest';
import { resolveCityAccess, hasForeignCityFilter, isPersonalAccessPath, scopeCityQuery } from './cityAccess';
const nodes = [
  {id:48,name:'Multipark',level:'group',parentId:null},
  {id:49,name:'Lisboa',level:'city',parentId:48},
  {id:50,name:'Porto',level:'city',parentId:48},
  {id:51,name:'Faro',level:'city',parentId:48},
  {id:55,name:'Redpark',level:'brand',parentId:50},
  {id:65,name:'Redpark Porto',level:'project',parentId:55},
  {id:66,name:'Outro Porto',level:'project',parentId:50},
];
describe('acesso por centro de custos',()=>{
 it('concede todas as cidades apenas ao centro Multipark',()=>{expect(resolveCityAccess(48,nodes).all).toBe(true);expect(resolveCityAccess(48,nodes).cityIds).toEqual([49,50,51]);});
 it.each([50,55,65])('concede todos os projetos do Porto a partir do centro %s',id=>{expect(resolveCityAccess(id,nodes)).toEqual({all:false,defaultCityId:50,cityName:'Porto',cityIds:[50],projectIds:[50,55,65,66],missingCostCenter:false});});
 it.each([null,999])('bloqueia centro em falta ou inexistente: %s',id=>expect(resolveCityAccess(id,nodes)).toMatchObject({all:false,cityIds:[],projectIds:[],missingCostCenter:true}));
 it('bloqueia ciclos e grupos desconhecidos',()=>{expect(resolveCityAccess(1,[{id:1,name:'Outro',level:'group',parentId:1}]).missingCostCenter).toBe(true);});
 it('imp�e a cidade quando o pedido omite os filtros',()=>{expect(scopeCityQuery('multipark.bookings',resolveCityAccess(50,nodes),undefined)).toEqual({city:'Porto'});expect(scopeCityQuery('rh.list',resolveCityAccess(50,nodes),{})).toEqual({projectId:50});});
 it('rejeita outra cidade, listas mistas e marcas globais',()=>{
   const access=resolveCityAccess(50,nodes);
   for(const input of [{projectId:49},{cityId:51},{projectIds:[65,49]},{projectId:-55}]) expect(hasForeignCityFilter(access,input)).toBe(true);
   expect(hasForeignCityFilter(access,{projectId:65})).toBe(false);
 });
 it('mantém o perfil disponível mas não abre a operação a quem não tem centro',()=>{
   expect(isPersonalAccessPath('rh.me')).toBe(true);
   expect(isPersonalAccessPath('permissions.myCityAccess')).toBe(true);
   expect(isPersonalAccessPath('multipark.bookings')).toBe(false);
   expect(isPersonalAccessPath('rh.list')).toBe(false);
 });
});
