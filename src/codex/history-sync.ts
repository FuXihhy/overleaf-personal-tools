/** Poll only while the conversation is visible. These are real history reads,
 * never worker keep-alives or replayed model requests. */
export class CodexHistorySync {
  private timer?:ReturnType<typeof setTimeout>;
  private pending?:Promise<void>;
  private stopped=false;
  constructor(private readonly options:{
    enabled():boolean;
    available():boolean;
    read():Promise<void>;
    failed(error:unknown):void;
    settled?():void;
    intervalMs?:number;
  }){}
  get busy(){return !!this.pending;}
  whenIdle(){return this.pending ?? Promise.resolve();}
  trigger(){
    clearTimeout(this.timer);this.timer=undefined;
    if(this.stopped || !this.options.enabled() || this.pending)return;
    if(!this.options.available()){this.schedule();return;}
    this.pending=Promise.resolve().then(()=>this.options.read()).catch(error=>{
      if(!this.stopped)this.options.failed(error);
    }).finally(()=>{this.pending=undefined;if(!this.stopped)this.options.settled?.();this.schedule();});
  }
  schedule(){
    clearTimeout(this.timer);this.timer=undefined;
    if(!this.stopped && this.options.enabled())this.timer=setTimeout(()=>{this.timer=undefined;this.trigger();},this.options.intervalMs??5000);
  }
  destroy(){this.stopped=true;clearTimeout(this.timer);this.timer=undefined;}
}
