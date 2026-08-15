const http=require("http");
const {spawn}=require("child_process");
const localtunnel=require("localtunnel");

async function main(){
  const server=spawn(process.execPath,[require.resolve("./server.js")],{stdio:"inherit",env:process.env});
  server.on("exit",code=>process.exit(code||0));
  const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
  await wait(1200);
  try{
    const tunnel=await localtunnel({port:Number(process.env.PORT||8787)});
    const publicUrl=tunnel.url;
    console.log("\n==============================");
    console.log(" SyncParty PUBLIC RELAY READY ");
    console.log("==============================");
    console.log("HTTP : "+publicUrl);
    console.log("WSS  : "+publicUrl.replace(/^https:/,"wss:"));
    console.log("\nPaste the WSS address into SyncParty on BOTH PCs.");
    console.log("Keep this terminal open while you watch.\n");
    tunnel.on("error",e=>console.error("Tunnel error:",e.message));
    tunnel.on("close",()=>console.log("Tunnel closed."));
    process.on("SIGINT",()=>{tunnel.close();server.kill();process.exit(0)});
  }catch(e){
    console.error("Could not create public tunnel:",e.message);
    server.kill();process.exit(1);
  }
}
main();