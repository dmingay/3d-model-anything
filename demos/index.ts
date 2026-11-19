import type { RoomModule } from '../packages/room-runtime/types';
export const ROOMS: RoomModule[] = [
  {id:'office-v4', label:'Wes’s office', build:async () => (await import('./office-v4')).officeV4.build()},
  {id:'front-garden', label:'Front garden · 19 Nov scan', build:async () => (await import('./front-garden')).frontGarden.build()},
  {id:'garden-synthetic', label:'Synthetic garden (sun test)', build:async () => (await import('./garden-synthetic')).gardenSynthetic.build()},
];
export const roomById = (id:string|null) => ROOMS.find(r=>r.id===id) ?? ROOMS[0];
export type {BuiltRoom, RoomModule} from '../packages/room-runtime/types';
