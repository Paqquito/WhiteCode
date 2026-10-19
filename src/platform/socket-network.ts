// Supports: SPEC-MCP-004, SPEC-PER-022 (shared proxy and trust settings for WebSocket upgrades), gap E-175.
import {rootCertificates}from"node:tls";
import{proxyFor,type NetworkSettings}from"../platform/network";
import type{WsClientHandlers,WsPeer}from"../platform/websocket";
export function connectNetworkWebSocket(url:string,headers:Record<string,string>,handlers:WsClientHandlers,settings:NetworkSettings):{close():void}{
 const proxy=proxyFor(new URL(url),settings),ca=settings.extraCa?[...rootCertificates,settings.extraCa]:undefined;
 const socket=new WebSocket(url,{headers,...(proxy?{proxy}:{}),tls:{rejectUnauthorized:true,...(ca?{ca}:{}),...(settings.clientCert?{cert:settings.clientCert,key:settings.clientKey}:{})}});let ended=false;
 const peer:WsPeer={send:text=>{socket.send(text);},close:(code,reason)=>socket.close(code,reason),remoteAddress:new URL(url).hostname};const end=()=>{if(!ended){ended=true;handlers.onClose();}};
 socket.onopen=()=>handlers.onOpen(peer);socket.onmessage=event=>{if(typeof event.data!=="string"){socket.close(1003,"Text frames required");return end();}handlers.onMessage(event.data);};socket.onclose=end;socket.onerror=end;return{close:()=>{if(!ended){socket.close(1000);end();}}};
}
