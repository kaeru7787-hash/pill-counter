/** Same-origin static comic; closing preserves the current analysis and edits. */
export class ComicGuide {
  private dialog = document.createElement("dialog");
  constructor(private opener: HTMLElement) {
    this.dialog.className="comic-dialog";
    this.dialog.setAttribute("aria-labelledby","comic-title");
    this.dialog.innerHTML=`<div class="comic-heading"><h2 id="comic-title">ピクト君の使い方ガイド</h2><button aria-label="漫画を閉じる">×</button></div><iframe title="操作方法の縦スクロール漫画"></iframe>`;
    document.body.append(this.dialog);
    const close=()=>this.dialog.close();
    this.dialog.querySelector("button")!.onclick=close;
    this.dialog.addEventListener("close",()=>this.opener.focus());
    this.opener.onclick=()=>{
      const frame=this.dialog.querySelector("iframe")!;
      if(!frame.getAttribute("src"))frame.src=new URL("guide/index.html",new URL(import.meta.env.BASE_URL,location.href)).href;
      this.dialog.showModal();
      this.dialog.querySelector("button")!.focus();
    };
  }
}
