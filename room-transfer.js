// Shared route grammar. Coordinates come from the current model/qualified destination.
export function directedPose(eye, yaw = 90, pitch = 0, fov = 72, extra = {}) {
  const r = Math.PI / 180, d = [Math.cos(pitch*r)*Math.cos(yaw*r), Math.cos(pitch*r)*Math.sin(yaw*r), -Math.sin(pitch*r)];
  return {t:eye.map((v,i)=>v+2.5*d[i]), eye:[...eye], yaw,pitch,fov,dist:2.5,frame:5*Math.tan(fov*r/2),focus:4,hold:0,go:70,...extra};
}
export function buildRoomTransfer(from, to, {flightZ, roomKey=null, targetCut=99, hover=45, floorCenter=null}={}) {
  if (![flightZ,...from.eye,...to.eye].every(Number.isFinite)) throw new RangeError('Transfer requires finite explicit eyes and flight altitude');
  if (flightZ < Math.max(from.eye[2],to.eye[2])) throw new RangeError('Flight altitude must clear both endpoints');
  const open=Math.min(from.eye[2],to.eye[2])-0.5,destinationOpen=Math.min(to.eye[2]-0.5,targetCut);
  const center=floorCenter??to.eye.slice(0,2);
  const p=(eye,yaw,pitch,fov,stage,cut,extra={})=>directedPose(eye,yaw,pitch,fov,{navigationStage:stage,roomKey,cut,...extra});
  return [
    {...from,eye:[...from.eye],hold:0,go:40,navigationStage:'open-cutaway',roomKey},
    p(from.eye,from.yaw,from.pitch,from.fov,'open-cutaway',open),
    p([from.eye[0],from.eye[1],flightZ],from.yaw,89,32,'rise',open),
    p([center[0],center[1],flightZ],90,89,32,'floor-plan-hover',destinationOpen,{hold:hover}),
    p([to.eye[0],to.eye[1],flightZ],to.yaw,89,32,'align',destinationOpen),
    p(to.eye,to.yaw,to.pitch,to.fov,'descend',destinationOpen),
    p(to.eye,to.yaw,to.pitch,to.fov,'restore',targetCut,{hold:55,go:0}),
  ];
}
