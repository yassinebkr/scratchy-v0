var LiveComponents = (function() {
  var _factories = {};
  function el(tag, opts) {
    var e = document.createElement(tag);
    if (opts) {
      if (opts.cls) e.className = opts.cls;
      if (opts.style) e.style.cssText = opts.style;
      if (opts.text) e.textContent = opts.text;
    }
    return e;
  }
  function setText(n, t) { if (n && n.textContent !== t) n.textContent = t; }
  function animateNum(n, from, to, dur, suffix) {
    dur = dur || 400; suffix = suffix || ""; var start = 0;
    function tick(now) {
      if (!start) start = now;
      var t = Math.min((now - start) / dur, 1);
      t = t === 1 ? 1 : 1 - Math.pow(2, -10 * t); // easeOutExpo
      n.textContent = Math.round(from + (to - from) * t) + suffix;
      if (t < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }
  // Animate a numeric value and call a setter each frame. Returns cancel fn.
  function animateValue(from, to, dur, eased, fn) {
    dur = dur || 500; var start = 0; var cancelled = false;
    function tick(now) {
      if (cancelled) return;
      if (!start) start = now;
      var t = Math.min((now - start) / dur, 1);
      if (eased) t = t === 1 ? 1 : 1 - Math.pow(2, -10 * t); // easeOutExpo
      fn(from + (to - from) * t, t);
      if (t < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
    return function() { cancelled = true; };
  }
  // Animate color from hex to hex
  function lerpColor(a, b, t) {
    var ah = parseInt(a.replace("#",""), 16), bh = parseInt(b.replace("#",""), 16);
    var ar = (ah >> 16) & 0xff, ag = (ah >> 8) & 0xff, ab = ah & 0xff;
    var br = (bh >> 16) & 0xff, bg = (bh >> 8) & 0xff, bb = bh & 0xff;
    var rr = Math.round(ar + (br - ar) * t);
    var rg = Math.round(ag + (bg - ag) * t);
    var rb = Math.round(ab + (bb - ab) * t);
    return "#" + ((1 << 24) + (rr << 16) + (rg << 8) + rb).toString(16).slice(1);
  }
  function applyGrad(e, g) {
    if (!g) return;
    e.style.background = Array.isArray(g) ? "linear-gradient(135deg," + g.join(",") + ")" : g;
  }

  _factories.hero = function(d) {
    var r = el("div", {style:"padding:28px 24px;border-radius:10px;text-align:center;transition:background 0.5s ease;"});
    applyGrad(r, d.gradient || ["#7c3aed","#3b82f6"]);
    var ic = el("div",{text:d.icon||"",style:"font-size:2.2rem;margin-bottom:8px;"});
    var ti = el("div",{text:d.title||"",style:"font-size:1.4rem;font-weight:600;color:#fff;margin-bottom:4px;"});
    var su = el("div",{text:d.subtitle||"",style:"font-size:0.85rem;color:rgba(255,255,255,0.75);"});
    var ba = el("div",{text:d.badge||"",style:"display:"+(d.badge?"inline-block":"none")+";margin-top:8px;padding:3px 10px;border-radius:12px;background:rgba(255,255,255,0.15);font-size:0.7rem;color:rgba(255,255,255,0.9);font-weight:600;"});
    r.appendChild(ic);r.appendChild(ti);r.appendChild(su);r.appendChild(ba);
    return {el:r, update:function(d){
      if(d.icon!=null)setText(ic,d.icon);if(d.title!=null)setText(ti,d.title);
      if(d.subtitle!=null)setText(su,d.subtitle);
      if(d.badge!=null){setText(ba,d.badge);ba.style.display=d.badge?"inline-block":"none";}
      if(d.gradient)applyGrad(r,d.gradient);
    }};
  };

  _factories.gauge = function(d) {
    var r=el("div",{style:"text-align:center;"});
    var svg=document.createElementNS("http://www.w3.org/2000/svg","svg");
    svg.setAttribute("viewBox","0 0 120 120");svg.style.cssText="width:120px;height:120px;";
    var bg=document.createElementNS("http://www.w3.org/2000/svg","circle");
    bg.setAttribute("cx","60");bg.setAttribute("cy","60");bg.setAttribute("r","50");
    bg.setAttribute("fill","none");bg.setAttribute("stroke","rgba(255,255,255,0.08)");bg.setAttribute("stroke-width","8");
    var fg=document.createElementNS("http://www.w3.org/2000/svg","circle");
    fg.setAttribute("cx","60");fg.setAttribute("cy","60");fg.setAttribute("r","50");
    fg.setAttribute("fill","none");fg.setAttribute("stroke",d.color||"#8b5cf6");
    fg.setAttribute("stroke-width","8");fg.setAttribute("stroke-linecap","round");
    fg.setAttribute("transform","rotate(-90 60 60)");
    var C=2*Math.PI*50;
    fg.style.strokeDasharray=C;
    fg.style.strokeDashoffset=C*(1-(d.value||0)/(d.max||100));
    svg.appendChild(bg);svg.appendChild(fg);
    var w=el("div",{style:"position:relative;display:inline-block;"});
    var ce=el("div",{style:"position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;width:90px;"});
    var unit=d.unit||"";
    var vl=el("div",{text:String(d.value||0)+(unit?" "+unit:""),style:"font-size:1.4rem;font-weight:700;line-height:1.2;white-space:nowrap;"});
    var lb=el("div",{text:d.label||"",style:"font-size:0.55rem;color:#888;text-transform:uppercase;letter-spacing:0.3px;line-height:1.3;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;white-space:normal;"});
    ce.appendChild(vl);ce.appendChild(lb);w.appendChild(svg);w.appendChild(ce);r.appendChild(w);
    var _c=d.value||0,_m=d.max||100,_color=d.color||"#8b5cf6",_cancelAnim=null;
    // C is already defined above as 2*Math.PI*50
    return {el:r,update:function(d){
      if(d.unit!=null)unit=d.unit;
      if(d.max!=null)_m=d.max;
      if(d.label!=null)setText(lb,d.label);
      var needsAnim=false;
      var newVal=_c,newColor=_color;
      if(d.value!=null&&d.value!==_c){newVal=d.value;needsAnim=true;}
      if(d.color&&d.color!==_color){newColor=d.color;needsAnim=true;}
      if(!needsAnim)return;
      // Cancel any running animation
      if(_cancelAnim)_cancelAnim();
      var oldVal=_c,oldColor=_color;
      _c=newVal;_color=newColor;
      // Animate number + arc + color in sync over 1.8s
      _cancelAnim=animateValue(0, 1, 1800, true, function(_, t) {
        var v = Math.round(oldVal + (newVal - oldVal) * t);
        vl.textContent = v + (unit ? " " + unit : "");
        fg.style.strokeDashoffset = C * (1 - (oldVal + (newVal - oldVal) * t) / _m);
        if (oldColor !== newColor) {
          try { fg.setAttribute("stroke", lerpColor(oldColor, newColor, t)); } catch(e) { fg.setAttribute("stroke", newColor); }
        }
      });
    }};
  };

  _factories.progress = function(d) {
    var r=el("div",{style:"padding:12px;background:rgba(255,255,255,0.04);border-radius:10px;"});
    var lb=el("div",{text:d.label||"",style:"font-size:0.85rem;color:#888;margin-bottom:8px;"});
    var br=el("div",{style:"height:8px;background:rgba(255,255,255,0.08);border-radius:4px;overflow:hidden;"});
    var fl=el("div",{style:"height:100%;border-radius:4px;background:linear-gradient(90deg,#e94560,#ff6b81);transition:width 1.2s cubic-bezier(0.22, 1, 0.36, 1);"});
    var p=Math.round(((d.value||0)/(d.max||100))*100);fl.style.width=p+"%";br.appendChild(fl);
    var pc=el("div",{text:p+"%",style:"font-size:0.8rem;color:#888;text-align:right;margin-top:4px;"});
    r.appendChild(lb);r.appendChild(br);r.appendChild(pc);
    var _m=d.max||100;
    return {el:r,update:function(d){
      if(d.max!=null)_m=d.max;if(d.label!=null)setText(lb,d.label);
      if(d.value!=null){var pp=Math.round((d.value/_m)*100);fl.style.width=pp+"%";setText(pc,pp+"%");}
    }};
  };

  _factories.weather = function(d) {
    var r=el("div",{style:"display:flex;align-items:center;gap:16px;padding:16px 20px;background:linear-gradient(135deg,rgba(100,181,246,0.15),rgba(66,165,245,0.05));border:1px solid rgba(100,181,246,0.2);border-radius:14px;"});
    var ic=el("div",{text:d.icon||"",style:"font-size:2.8rem;"});
    var inf=el("div");
    var ci=el("div",{text:d.city||"",style:"font-size:0.85rem;color:#888;text-transform:uppercase;letter-spacing:0.5px;"});
    var te=el("div",{text:d.temp||"",style:"font-size:1.8rem;font-weight:700;color:#fff;line-height:1.2;"});
    var co=el("div",{text:d.condition||"",style:"font-size:0.9rem;color:#888;"});
    inf.appendChild(ci);inf.appendChild(te);inf.appendChild(co);r.appendChild(ic);r.appendChild(inf);
    return {el:r,update:function(d){
      if(d.icon!=null)setText(ic,d.icon);if(d.city!=null)setText(ci,d.city);
      if(d.temp!=null)setText(te,d.temp);if(d.condition!=null)setText(co,d.condition);
    }};
  };

  _factories.alert = function(d) {
    var s=d.severity||"info";
    var cs={info:"59,130,246",warning:"245,158,11",error:"239,68,68",success:"16,185,129"};
    var is_={info:"\u2139\ufe0f",warning:"\u26a0\ufe0f",error:"\ud83d\udd34",success:"\u2705"};
    var r=el("div",{style:"display:flex;gap:10px;padding:12px 14px;border-radius:10px;border:1px solid rgba("+(cs[s])+",0.3);background:rgba("+(cs[s])+",0.1);transition:background 0.4s ease,border-color 0.4s ease;"});
    var ic=el("div",{text:is_[s],style:"font-size:1.2rem;flex-shrink:0;"});
    var bd=el("div");
    var ti=el("div",{text:d.title||"",style:"font-weight:600;margin-bottom:2px;"});
    var mg=el("div",{text:d.message||"",style:"font-size:0.9rem;color:#888;"});
    bd.appendChild(ti);bd.appendChild(mg);r.appendChild(ic);r.appendChild(bd);
    return {el:r,update:function(d){
      if(d.severity&&d.severity!==s){s=d.severity;r.style.borderColor="rgba("+(cs[s]||cs.info)+",0.3)";r.style.background="rgba("+(cs[s]||cs.info)+",0.1)";setText(ic,is_[s]||is_.info);}
      if(d.title!=null)setText(ti,d.title);if(d.message!=null)setText(mg,d.message);
    }};
  };

  _factories.stats = function(d) {
    var r=el("div");var tl=null;
    if(d.title){tl=el("div",{text:d.title,style:"font-weight:600;margin-bottom:8px;"});r.appendChild(tl);}
    var gr=el("div",{style:"display:grid;grid-template-columns:repeat(auto-fit,minmax(90px,1fr));gap:8px;"});
    r.appendChild(gr);var se=[];
    function build(items){gr.innerHTML="";se=[];(items||[]).forEach(function(it){
      var c=el("div",{style:"background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:10px 8px;text-align:center;"});
      var v=el("div",{text:String(it.value||""),style:"font-size:1.3rem;font-weight:700;line-height:1.2;"});
      var l=el("div",{text:it.label||"",style:"font-size:0.75rem;color:#888;margin-top:4px;text-transform:uppercase;letter-spacing:0.5px;"});
      c.appendChild(v);c.appendChild(l);
      if(it.trend){var t=el("div",{text:it.trend==="up"?"\u25b2":"\u25bc",style:"font-size:0.8rem;margin-top:4px;font-weight:600;color:"+(it.trend==="up"?"#10b981":"#ef4444")+";"}); c.appendChild(t);}
      gr.appendChild(c);se.push({v:v,l:l});
    });}
    build(d.items);
    return {el:r,update:function(d){
      if(d.title!=null&&tl)setText(tl,d.title);
      if(d.items){if(d.items.length!==se.length)build(d.items);else d.items.forEach(function(it,i){setText(se[i].v,String(it.value||""));setText(se[i].l,it.label||"");});}
    }};
  };

  _factories.checklist = function(d) {
    var r=el("div",{style:"background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:10px;overflow:hidden;"});
    var tl=null;
    if(d.title){tl=el("div",{text:d.title,style:"padding:10px 14px;font-weight:600;background:rgba(255,255,255,0.03);border-bottom:1px solid rgba(255,255,255,0.06);"});r.appendChild(tl);}
    var ls=el("div");r.appendChild(ls);var ie=[];
    function build(items){ls.innerHTML="";ie=[];(items||[]).forEach(function(it){
      var row=el("div",{style:"display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid rgba(255,255,255,0.04);"});
      var bx=el("div",{text:it.checked?"\u2713":""});
      bx.style.cssText="width:20px;height:20px;border-radius:5px;border:2px solid "+(it.checked?"#10b981":"rgba(255,255,255,0.2)")+";display:flex;align-items:center;justify-content:center;font-size:0.7rem;flex-shrink:0;color:"+(it.checked?"#fff":"transparent")+";background:"+(it.checked?"#10b981":"transparent")+";transition:all 0.3s ease;";
      var tx=el("div",{text:it.text||""});
      tx.style.cssText="transition:opacity 0.3s ease;"+(it.checked?"text-decoration:line-through;opacity:0.6;":"");
      row.appendChild(bx);row.appendChild(tx);ls.appendChild(row);
      ie.push({bx:bx,tx:tx,ck:!!it.checked});
    });}
    build(d.items);
    return {el:r,update:function(d){
      if(d.title!=null&&tl)setText(tl,d.title);
      if(d.items){
        if(d.items.length!==ie.length)build(d.items);
        else d.items.forEach(function(it,i){
          var e=ie[i];setText(e.tx,it.text||"");
          if(!!it.checked!==e.ck){e.ck=!!it.checked;e.bx.textContent=e.ck?"\u2713":"";
            e.bx.style.borderColor=e.ck?"#10b981":"rgba(255,255,255,0.2)";
            e.bx.style.color=e.ck?"#fff":"transparent";
            e.bx.style.background=e.ck?"#10b981":"transparent";
            e.tx.style.textDecoration=e.ck?"line-through":"none";
            e.tx.style.opacity=e.ck?"0.6":"1";
          }
        });
      }
    }};
  };

  // ── Card ── (defined later at ~L934 with richText + action/menu support)

  // ── KV ──
  _factories.kv = function(d) {
    var r=el("div",{style:"padding:14px 16px;"});
    var tl=null;
    if(d.title){tl=el("div",{text:d.title,style:"font-size:0.75rem;color:#888;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px;"});r.appendChild(tl);}
    var ls=el("div");r.appendChild(ls);var rows=[];
    function build(items){ls.innerHTML="";rows=[];(items||[]).forEach(function(pair){
      var k=Array.isArray(pair)?pair[0]:(pair.key||pair.label||"");
      var v=Array.isArray(pair)?pair[1]:(pair.value||pair.val||"");
      var row=el("div",{style:"display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.04);"});
      var ke=el("span",{text:k,style:"font-size:0.78rem;color:#888;"});
      var ve=el("span",{text:v,style:"font-size:0.78rem;color:#ddd;font-weight:500;"});
      row.appendChild(ke);row.appendChild(ve);ls.appendChild(row);
      rows.push({k:ke,v:ve});
    });}
    build(d.items);
    return {el:r,update:function(d){
      if(d.title!=null&&tl)setText(tl,d.title);
      if(d.items){if(d.items.length!==rows.length)build(d.items);else d.items.forEach(function(pair,i){
        var k=Array.isArray(pair)?pair[0]:(pair.key||pair.label||"");
        var v=Array.isArray(pair)?pair[1]:(pair.value||pair.val||"");
        setText(rows[i].k,k);setText(rows[i].v,v);
      });}
    }};
  };

  // ── Buttons ── (defined later at ~L779 with full style support)

  // ── Timeline ──
  _factories.timeline = function(d) {
    var r=el("div",{style:"padding:14px 16px;"});
    var tl=null;
    if(d.title){tl=el("div",{text:d.title,style:"font-size:0.75rem;color:#888;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:12px;"});r.appendChild(tl);}
    var ls=el("div");r.appendChild(ls);
    function build(items){
      ls.innerHTML="";(items||[]).forEach(function(it,i){
        var row=el("div",{style:"display:flex;gap:12px;position:relative;"});
        var left=el("div",{style:"display:flex;flex-direction:column;align-items:center;flex-shrink:0;"});
        var dot=el("div",{text:it.icon||"•",style:"width:24px;height:24px;border-radius:50%;background:rgba(124,58,237,0.15);display:flex;align-items:center;justify-content:center;font-size:0.7rem;overflow:hidden;text-overflow:clip;"});
        left.appendChild(dot);
        if(i<(items.length-1)){var line=el("div",{style:"width:1px;flex:1;background:rgba(255,255,255,0.06);margin:4px 0;"});left.appendChild(line);}
        var right=el("div",{style:"padding-bottom:"+(i<items.length-1?"14":"0")+"px;"});
        var dt=el("div",{text:it.date||it.time||"",style:"font-size:0.68rem;color:#888;"});
        var tt=el("div",{text:it.title||it.text||"",style:"font-size:0.82rem;font-weight:500;color:#ddd;margin:2px 0;"});
        right.appendChild(dt);right.appendChild(tt);
        if(it.text&&it.title){var desc=el("div",{text:it.text,style:"font-size:0.75rem;color:#999;"});right.appendChild(desc);}
        if(it.status){var st=el("span",{text:it.status,style:"font-size:0.65rem;padding:2px 6px;border-radius:8px;background:rgba(124,58,237,0.15);color:#a78bfa;"});right.appendChild(st);}
        row.appendChild(left);row.appendChild(right);ls.appendChild(row);
      });
    }
    build(d.items);
    return {el:r,update:function(d){
      if(d.title!=null&&tl)setText(tl,d.title);
      if(d.items)build(d.items);
    }};
  };

  // ── Tags ──
  _factories.tags = function(d) {
    var r=el("div",{style:"padding:12px 16px;"});
    var lb=null;
    if(d.label){lb=el("div",{text:d.label,style:"font-size:0.72rem;color:#888;margin-bottom:8px;"});r.appendChild(lb);}
    var gr=el("div",{style:"display:flex;flex-wrap:wrap;gap:6px;"});r.appendChild(gr);
    function build(items){
      gr.innerHTML="";(items||[]).forEach(function(it){
        var c=it.color||"#3b82f6";
        var sp=el("span",{text:it.text||it.label||"",style:"font-size:0.72rem;padding:3px 10px;border-radius:12px;background:"+c+"22;color:"+c+";border:1px solid "+c+"33;"});
        gr.appendChild(sp);
      });
    }
    build(d.items);
    return {el:r,update:function(d){
      if(d.label!=null&&lb)setText(lb,d.label);
      if(d.items)build(d.items);
    }};
  };

  // ── Table ──
  _factories.table = function(d) {
    var r=el("div",{style:"padding:14px 16px;"});
    var tl=null;
    if(d.title){tl=el("div",{text:d.title,style:"font-size:0.75rem;color:#888;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px;"});r.appendChild(tl);}
    var tbl=document.createElement("table");
    tbl.style.cssText="width:100%;border-collapse:collapse;font-size:0.78rem;";
    r.appendChild(tbl);
    function renderCell(td, cell) {
      if (cell && typeof cell === "object" && cell.action) {
        // Action button cell: {text, action, context, style}
        var btn = document.createElement("button");
        btn.textContent = cell.text || cell.label || "Action";
        var isPrimary = cell.style === "primary";
        btn.style.cssText = "padding:3px 10px;border-radius:6px;font-size:0.72rem;cursor:pointer;border:1px solid " + (isPrimary ? "var(--accent, #6366f1)" : "rgba(255,255,255,0.12)") + ";background:" + (isPrimary ? "var(--accent, #6366f1)" : "transparent") + ";color:" + (isPrimary ? "#fff" : "#aaa") + ";transition:background 0.15s;";
        btn.onmouseenter = function(){ btn.style.background = isPrimary ? "var(--accent-hover, #4f46e5)" : "rgba(255,255,255,0.06)"; };
        btn.onmouseleave = function(){ btn.style.background = isPrimary ? "var(--accent, #6366f1)" : "transparent"; };
        btn.onclick = function(e) {
          e.stopPropagation();
          if (window._scratchyWidgetAction) {
            window._scratchyWidgetAction(cell.action, cell.context || {});
          }
        };
        td.appendChild(btn);
      } else {
        td.textContent = cell == null ? "" : String(cell);
      }
    }
    function build(headers,rows){
      tbl.innerHTML="";
      if(headers&&headers.length){
        var thead=document.createElement("tr");
        headers.forEach(function(h){var th=document.createElement("th");th.textContent=h;th.style.cssText="text-align:left;padding:6px 8px;color:#888;font-weight:500;border-bottom:1px solid rgba(255,255,255,0.08);";thead.appendChild(th);});
        tbl.appendChild(thead);
      }
      (rows||[]).forEach(function(row){
        var tr=document.createElement("tr");
        var rowArr=Array.isArray(row)?row:(typeof row==="string"?row.split(",").map(function(s){return s.trim();}):[]);
        rowArr.forEach(function(cell){
          var td=document.createElement("td");
          td.style.cssText="padding:6px 8px;color:#ccc;border-bottom:1px solid rgba(255,255,255,0.03);";
          renderCell(td, cell);
          tr.appendChild(td);
        });
        tbl.appendChild(tr);
      });
    }
    build(d.headers,d.rows);
    return {el:r,update:function(d){
      if(d.title!=null&&tl)setText(tl,d.title);
      if(d.headers||d.rows)build(d.headers,d.rows);
    }};
  };

  // ── Sparkline ──
  _factories.sparkline = function(d) {
    var r=el("div",{style:"padding:12px 16px;display:flex;align-items:center;gap:12px;"});
    var info=el("div");
    var vl=el("div",{text:String(d.value||""),style:"font-size:1.1rem;font-weight:600;color:#ddd;"});
    var lb=el("div",{text:d.label||"",style:"font-size:0.7rem;color:#888;"});
    info.appendChild(vl);info.appendChild(lb);r.appendChild(info);
    var svgNS="http://www.w3.org/2000/svg";
    var svg=document.createElementNS(svgNS,"svg");svg.setAttribute("viewBox","0 0 80 28");svg.style.cssText="width:80px;height:28px;";
    var poly=document.createElementNS(svgNS,"polyline");
    poly.setAttribute("fill","none");poly.setAttribute("stroke",d.color||"#10b981");poly.setAttribute("stroke-width","1.5");poly.setAttribute("stroke-linejoin","round");
    svg.appendChild(poly);r.appendChild(svg);
    var tr_=null;
    if(d.trend){tr_=el("div",{text:d.trend,style:"font-size:0.75rem;margin-left:auto;transition:color 0.4s ease;color:"+(String(d.trend).startsWith("-")?"#ef4444":"#10b981")+";"});r.appendChild(tr_);}
    function setPoints(pts){
      if(!pts||pts.length<2)return;
      var min=Math.min.apply(null,pts),max=Math.max.apply(null,pts);if(max===min)max=min+1;
      var coords=pts.map(function(v,i){return(i/(pts.length-1))*80+","+(2+(1-(v-min)/(max-min))*24);}).join(" ");
      poly.setAttribute("points",coords);
    }
    setPoints(d.values||d.points||[]);
    var _curPts=d.values||d.points||[];
    var _curColor=d.color||"#10b981";
    var _cancelAnim=null;
    return {el:r,update:function(d){
      if(d.value!=null)setText(vl,String(d.value));
      if(d.label!=null)setText(lb,d.label);
      if(d.trend!=null&&tr_){setText(tr_,d.trend);tr_.style.color=String(d.trend).startsWith("-")?"#ef4444":"#10b981";}
      if(d.values||d.points||d.color){
        if(_cancelAnim)_cancelAnim();
        var newPts=d.values||d.points||_curPts;
        var oldPts=_curPts.slice();
        while(oldPts.length<newPts.length)oldPts.push(oldPts[oldPts.length-1]||0);
        while(newPts.length<oldPts.length)newPts.push(newPts[newPts.length-1]||0);
        _curPts=newPts.slice();
        var newColor=d.color||_curColor;var oldColor=_curColor;_curColor=newColor;
        _cancelAnim=animateValue(0,1,800,true,function(_,t){
          var interp=oldPts.map(function(v,i){return v+(newPts[i]-v)*t;});
          setPoints(interp);
          if(oldColor!==newColor){try{poly.setAttribute("stroke",lerpColor(oldColor,newColor,t));}catch(e){poly.setAttribute("stroke",newColor);}}
        });
      }
    }};
  };

  // ── Code ──
  _factories.code = function(d) {
    var r=el("div",{style:"padding:0;"});
    var hdr=null;
    if(d.language){hdr=el("div",{text:d.language,style:"padding:6px 14px;font-size:0.68rem;color:#666;border-bottom:1px solid rgba(255,255,255,0.04);text-transform:uppercase;letter-spacing:0.05em;"});r.appendChild(hdr);}
    var pre=el("pre",{style:"margin:0;padding:12px 14px;font-family:JetBrains Mono,Fira Code,monospace;font-size:0.78rem;line-height:1.6;overflow-x:auto;color:#c9d1d9;"});
    r.appendChild(pre);
    function build(code){
      pre.innerHTML="";(code||"").split("\n").forEach(function(line,i){
        var row=el("div",{style:"display:flex;gap:12px;"});
        var num=el("span",{text:String(i+1),style:"color:#555;user-select:none;min-width:20px;text-align:right;"});
        var txt=el("span",{text:line});
        row.appendChild(num);row.appendChild(txt);pre.appendChild(row);
      });
    }
    build(d.code);
    return {el:r,update:function(d){
      if(d.language!=null&&hdr)setText(hdr,d.language);
      if(d.code!=null)build(d.code);
    }};
  };

  // ── Accordion ──
  _factories.accordion = function(d) {
    var r=el("div",{style:"padding:14px 16px;"});
    var tl=null;
    if(d.title){tl=el("div",{text:d.title,style:"font-size:0.75rem;color:#888;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px;"});r.appendChild(tl);}
    var ls=el("div");r.appendChild(ls);
    function build(sections){
      ls.innerHTML="";(sections||[]).forEach(function(s){
        var det=document.createElement("details");if(s.open!==false)det.open=true;
        det.style.cssText="border-bottom:1px solid rgba(255,255,255,0.04);padding:8px 0;";
        var sum=document.createElement("summary");sum.textContent=s.title||"";sum.style.cssText="font-size:0.82rem;color:#ddd;cursor:pointer;padding:4px 0;";
        var body=el("div",{text:s.content||s.text||"",style:"font-size:0.78rem;color:#999;padding:6px 0;line-height:1.5;"});
        det.appendChild(sum);det.appendChild(body);ls.appendChild(det);
      });
    }
    build(d.sections);
    return {el:r,update:function(d){
      if(d.title!=null&&tl)setText(tl,d.title);
      if(d.sections)build(d.sections);
    }};
  };

  // ══════════════════════════════════════════════════════════
  // Core LiveComponents for efficient patch updates (no innerHTML rebuild)
  // Used by admin dashboard, monitor, quotas, providers etc.
  // ══════════════════════════════════════════════════════════

  // ── Stats ──
  _factories["stats"] = function(d) {
    var r = el("div", {style: "padding:14px 16px;"});
    var tl = null;
    if (d.title) { tl = el("div", {text: d.title, style: "font-size:0.75rem;color:#888;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px;"}); r.appendChild(tl); }
    var grid = el("div");
    r.appendChild(grid);
    var _itemEls = []; // [{valEl, lblEl, trendEl}]
    function rebuild(items) {
      grid.innerHTML = "";
      _itemEls = [];
      items = items || [];
      grid.style.cssText = "display:grid;grid-template-columns:repeat(" + items.length + ",1fr);gap:12px;";
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var c = it.color || "#3b82f6";
        var col = el("div");
        var valEl = el("div", {text: String(it.value || ""), style: "font-size:1.3rem;font-weight:600;color:" + c + ";"});
        var lblEl = el("div", {text: String(it.label || ""), style: "font-size:0.75rem;color:#888;margin-top:2px;"});
        col.appendChild(valEl);
        col.appendChild(lblEl);
        var trendEl = null;
        if (it.trend) {
          trendEl = el("div", {text: String(it.trend), style: "font-size:0.7rem;color:" + (String(it.trend).startsWith("-") ? "#ef4444" : "#10b981") + ";margin-top:2px;"});
          col.appendChild(trendEl);
        }
        grid.appendChild(col);
        _itemEls.push({valEl: valEl, lblEl: lblEl, trendEl: trendEl, col: col, color: c});
      }
    }
    rebuild(d.items);
    return {el: r, update: function(nd) {
      if (nd.title != null && tl) setText(tl, nd.title);
      if (nd.items) {
        var items = nd.items;
        if (items.length !== _itemEls.length) { rebuild(items); return; }
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          setText(_itemEls[i].valEl, String(it.value || ""));
          setText(_itemEls[i].lblEl, String(it.label || ""));
          if (it.color && it.color !== _itemEls[i].color) {
            _itemEls[i].valEl.style.color = it.color;
            _itemEls[i].color = it.color;
          }
        }
      }
    }};
  };

  // ── Gauge ──
  _factories["gauge"] = function(d) {
    var r = el("div", {style: "padding:14px 16px;text-align:center;"});
    var titleEl = null;
    if (d.title) { titleEl = el("div", {text: d.title, style: "font-size:0.72rem;color:#888;margin-bottom:8px;"}); r.appendChild(titleEl); }
    var val = d.value || 0, max = d.max || 100;
    var pct = Math.min(val / max, 1);
    var _radius = 36, circ = Math.PI * _radius;
    var svgNS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", "0 0 90 55");
    svg.style.cssText = "width:90px;height:55px;";
    var bgArc = document.createElementNS(svgNS, "path");
    bgArc.setAttribute("d", "M 9 50 A 36 36 0 0 1 81 50");
    bgArc.setAttribute("fill", "none");
    bgArc.setAttribute("stroke", "rgba(255,255,255,0.06)");
    bgArc.setAttribute("stroke-width", "8");
    bgArc.setAttribute("stroke-linecap", "round");
    svg.appendChild(bgArc);
    var fgArc = document.createElementNS(svgNS, "path");
    fgArc.setAttribute("d", "M 9 50 A 36 36 0 0 1 81 50");
    fgArc.setAttribute("fill", "none");
    fgArc.setAttribute("stroke", d.color || "#3b82f6");
    fgArc.setAttribute("stroke-width", "8");
    fgArc.setAttribute("stroke-linecap", "round");
    fgArc.setAttribute("stroke-dasharray", (pct * circ).toFixed(1) + " " + circ.toFixed(1));
    fgArc.style.cssText = "transition: stroke-dasharray 0.6s cubic-bezier(0.16, 1, 0.3, 1), stroke 0.4s ease;";
    svg.appendChild(fgArc);
    r.appendChild(svg);
    var labelEl = el("div", {text: String(d.label || val), style: "font-size:1rem;font-weight:600;color:#ddd;margin-top:-4px;"});
    r.appendChild(labelEl);
    var _cur = {val: val, max: max, color: d.color || "#3b82f6"};
    return {el: r, update: function(nd) {
      if (nd.title != null && titleEl) setText(titleEl, nd.title);
      var v = nd.value != null ? nd.value : _cur.val;
      var m = nd.max != null ? nd.max : _cur.max;
      var c = nd.color || _cur.color;
      var p = Math.min(v / m, 1);
      fgArc.setAttribute("stroke-dasharray", (p * circ).toFixed(1) + " " + circ.toFixed(1));
      if (c !== _cur.color) fgArc.setAttribute("stroke", c);
      if (nd.label != null) setText(labelEl, String(nd.label));
      else if (nd.value != null) setText(labelEl, String(v));
      if (nd.unit != null) setText(labelEl, String(v) + " " + nd.unit);
      _cur.val = v; _cur.max = m; _cur.color = c;
    }};
  };

  // ── KV (Key-Value) ──
  _factories["kv"] = function(d) {
    var r = el("div", {style: "padding:14px 16px;"});
    var tl = null;
    if (d.title) { tl = el("div", {text: d.title, style: "font-size:0.75rem;color:#888;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px;"}); r.appendChild(tl); }
    var list = el("div");
    r.appendChild(list);
    var _rowEls = []; // [{keyEl, valEl}]
    function rebuild(items) {
      list.innerHTML = "";
      _rowEls = [];
      items = items || [];
      for (var i = 0; i < items.length; i++) {
        var pair = items[i];
        var k = Array.isArray(pair) ? pair[0] : (pair.key || pair.label || "");
        var v = Array.isArray(pair) ? pair[1] : (pair.value || pair.val || "");
        var row = el("div", {style: "display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.04);"});
        var keyEl = el("span", {text: String(k), style: "font-size:0.78rem;color:#888;"});
        var valEl = el("span", {text: String(v), style: "font-size:0.78rem;color:#ddd;font-weight:500;"});
        row.appendChild(keyEl);
        row.appendChild(valEl);
        list.appendChild(row);
        _rowEls.push({keyEl: keyEl, valEl: valEl});
      }
    }
    rebuild(d.items);
    return {el: r, update: function(nd) {
      if (nd.title != null && tl) setText(tl, nd.title);
      if (nd.items) {
        var items = nd.items;
        if (items.length !== _rowEls.length) { rebuild(items); return; }
        for (var i = 0; i < items.length; i++) {
          var pair = items[i];
          var k = Array.isArray(pair) ? pair[0] : (pair.key || pair.label || "");
          var v = Array.isArray(pair) ? pair[1] : (pair.value || pair.val || "");
          setText(_rowEls[i].keyEl, String(k));
          setText(_rowEls[i].valEl, String(v));
        }
      }
    }};
  };

  // ── Table ──
  _factories["table"] = function(d) {
    var r = el("div", {style: "padding:14px 16px;"});
    var tl = null;
    if (d.title) { tl = el("div", {text: d.title, style: "font-size:0.75rem;color:#888;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px;"}); r.appendChild(tl); }
    var tbl = document.createElement("table");
    tbl.style.cssText = "width:100%;border-collapse:collapse;font-size:0.78rem;";
    var thead = document.createElement("thead");
    var tbody = document.createElement("tbody");
    tbl.appendChild(thead);
    tbl.appendChild(tbody);
    r.appendChild(tbl);
    var _headers = [];
    var _rowEls = []; // [[td, td, ...], ...]
    function buildHead(headers) {
      thead.innerHTML = "";
      _headers = headers || [];
      if (_headers.length === 0) return;
      var tr = document.createElement("tr");
      for (var i = 0; i < _headers.length; i++) {
        var th = document.createElement("th");
        th.style.cssText = "text-align:left;padding:6px 8px;color:#888;font-weight:500;border-bottom:1px solid rgba(255,255,255,0.08);";
        th.textContent = String(_headers[i]);
        tr.appendChild(th);
      }
      thead.appendChild(tr);
    }
    function normalizeRow(row) {
      if (Array.isArray(row)) return row;
      if (typeof row === "string") return row.split(",").map(function(s){ return s.trim(); });
      return [];
    }
    function renderCell(td, cellVal) {
      // Action button object: { text: "Label", action: "...", context: {...} }
      if (cellVal && typeof cellVal === "object" && cellVal.text && cellVal.action) {
        td.innerHTML = "";
        var btn = document.createElement("button");
        btn.textContent = cellVal.text;
        btn.style.cssText = "background:transparent;border:1px solid rgba(255,255,255,0.15);color:#a5b4fc;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:0.72rem;white-space:nowrap;";
        btn.onmouseenter = function() { btn.style.borderColor = "#6366f1"; btn.style.color = "#c7d2fe"; };
        btn.onmouseleave = function() { btn.style.borderColor = "rgba(255,255,255,0.15)"; btn.style.color = "#a5b4fc"; };
        btn.setAttribute("data-sui-send", cellVal.action);
        if (cellVal.context) { btn.setAttribute("data-sui-context", JSON.stringify(cellVal.context)); }
        td.appendChild(btn);
      } else {
        td.textContent = (cellVal == null) ? "" : String(cellVal);
      }
    }
    function buildBody(rows) {
      tbody.innerHTML = "";
      _rowEls = [];
      rows = rows || [];
      for (var r = 0; r < rows.length; r++) {
        var tr = document.createElement("tr");
        var cells = [];
        var rowData = normalizeRow(rows[r]);
        for (var c = 0; c < rowData.length; c++) {
          var td = document.createElement("td");
          td.style.cssText = "padding:6px 8px;color:#ccc;border-bottom:1px solid rgba(255,255,255,0.03);";
          renderCell(td, rowData[c]);
          tr.appendChild(td);
          cells.push(td);
        }
        tbody.appendChild(tr);
        _rowEls.push(cells);
      }
    }
    buildHead(d.headers);
    buildBody(d.rows);
    return {el: r, update: function(nd) {
      if (nd.title != null && tl) setText(tl, nd.title);
      if (nd.headers) buildHead(nd.headers);
      if (nd.rows) {
        var rows = nd.rows;
        // If same row count, update cells in-place
        if (rows.length === _rowEls.length) {
          var needRebuild = false;
          for (var r = 0; r < rows.length; r++) {
            var rowData = normalizeRow(rows[r]);
            if (rowData.length !== _rowEls[r].length) { needRebuild = true; break; }
            for (var c = 0; c < rowData.length; c++) {
              setText(_rowEls[r][c], String(rowData[c]));
            }
          }
          if (needRebuild) buildBody(rows);
        } else {
          buildBody(rows);
        }
      }
    }};
  };

  // ── Progress ──
  _factories["progress"] = function(d) {
    var r = el("div", {style: "padding:12px 16px;"});
    var hdr = el("div", {style: "display:flex;justify-content:space-between;margin-bottom:6px;"});
    var lblEl = el("span", {text: String(d.label || ""), style: "font-size:0.78rem;color:#aaa;"});
    var pctEl = el("span", {text: (d.value || 0) + "%", style: "font-size:0.78rem;color:#ddd;font-weight:500;"});
    hdr.appendChild(lblEl);
    hdr.appendChild(pctEl);
    r.appendChild(hdr);
    var track = el("div", {style: "height:6px;background:rgba(255,255,255,0.06);border-radius:3px;overflow:hidden;"});
    var c = d.color || null;
    var bg = c ? c : "linear-gradient(90deg,#7c3aed,#3b82f6)";
    var fill = el("div", {style: "height:100%;width:" + (d.value || 0) + "%;background:" + bg + ";border-radius:3px;transition:width 0.5s ease;"});
    track.appendChild(fill);
    r.appendChild(track);
    return {el: r, update: function(nd) {
      if (nd.label != null) setText(lblEl, String(nd.label));
      if (nd.value != null) {
        pctEl.textContent = nd.value + "%";
        fill.style.width = nd.value + "%";
      }
      if (nd.color) {
        fill.style.background = nd.color;
      }
    }};
  };

  // ── Buttons ──
  _factories["buttons"] = function(d) {
    var r = el("div", {style: "padding:12px 16px;"});
    var titleEl = null;
    if (d.title) { titleEl = el("div", {text: d.title, style: "font-size:0.85rem;font-weight:600;color:#ddd;margin-bottom:10px;"}); r.appendChild(titleEl); }
    var textEl = null;
    if (d.text) { textEl = el("div", {text: d.text, style: "font-size:0.82rem;color:#aaa;margin-bottom:10px;"}); r.appendChild(textEl); }
    var row = el("div", {style: "display:flex;flex-wrap:wrap;gap:8px;"});
    r.appendChild(row);
    var _btnEls = [];
    function rebuild(buttons) {
      row.innerHTML = "";
      _btnEls = [];
      var btns = buttons || d.buttons || [];
      for (var i = 0; i < btns.length; i++) {
        var b = typeof btns[i] === "string" ? {label: btns[i], action: btns[i]} : btns[i];
        var action = b.action || b.label || "";
        var label = b.label || b.action || "";
        var style = b.style || "ghost";
        var bg = style === "primary" ? "#7c3aed" : style === "danger" ? "#ef4444" : "rgba(255,255,255,0.06)";
        var color = (style === "primary" || style === "danger") ? "#fff" : "#ccc";
        var btn = document.createElement("button");
        btn.textContent = label;
        btn.setAttribute("data-sui-send", action);
        if (b.context) { btn.setAttribute("data-sui-context", JSON.stringify(b.context)); }
        btn.style.cssText = "padding:7px 16px;border-radius:8px;border:none;background:" + bg + ";color:" + color + ";font-size:0.78rem;cursor:pointer;transition:opacity 0.15s;";
        row.appendChild(btn);
        _btnEls.push({el: btn, action: action, style: style});
      }
    }
    rebuild(d.buttons);
    return {el: r, update: function(nd) {
      if (nd.title != null && titleEl) setText(titleEl, nd.title);
      if (nd.text != null && textEl) setText(textEl, nd.text);
      if (nd.buttons) rebuild(nd.buttons);
    }};
  };

  // ── Timeline ──
  _factories["timeline"] = function(d) {
    var r = el("div", {style: "padding:14px 16px;"});
    var tl = null;
    if (d.title) { tl = el("div", {text: d.title, style: "font-size:0.75rem;color:#888;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px;"}); r.appendChild(tl); }
    var list = el("div");
    r.appendChild(list);
    var _itemEls = [];
    function rebuild(items) {
      list.innerHTML = "";
      _itemEls = [];
      items = items || [];
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var row = el("div", {style: "display:flex;gap:10px;padding:6px 0;" + (i < items.length - 1 ? "border-bottom:1px solid rgba(255,255,255,0.04);" : "")});
        var iconEl = el("div", {text: it.icon || "●", style: "font-size:0.85rem;flex-shrink:0;width:20px;text-align:center;"});
        var body = el("div", {style: "flex:1;min-width:0;"});
        var titleEl = el("div", {text: it.title || "", style: "font-size:0.82rem;color:#ddd;font-weight:500;"});
        var textEl = el("div", {text: it.text || it.desc || "", style: "font-size:0.75rem;color:#888;margin-top:2px;line-height:1.4;"});
        body.appendChild(titleEl);
        body.appendChild(textEl);
        var timeEl = null;
        if (it.time || it.date) {
          timeEl = el("div", {text: it.time || it.date || "", style: "font-size:0.7rem;color:#666;flex-shrink:0;white-space:nowrap;"});
        }
        row.appendChild(iconEl);
        row.appendChild(body);
        if (timeEl) row.appendChild(timeEl);
        list.appendChild(row);
        _itemEls.push({iconEl: iconEl, titleEl: titleEl, textEl: textEl, timeEl: timeEl});
      }
    }
    rebuild(d.items);
    return {el: r, update: function(nd) {
      if (nd.title != null && tl) setText(tl, nd.title);
      if (nd.items) {
        var items = nd.items;
        if (items.length !== _itemEls.length) { rebuild(items); return; }
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          setText(_itemEls[i].titleEl, it.title || "");
          setText(_itemEls[i].textEl, it.text || it.desc || "");
          setText(_itemEls[i].iconEl, it.icon || "●");
          if (_itemEls[i].timeEl) setText(_itemEls[i].timeEl, it.time || it.date || "");
        }
      }
    }};
  };

  // ── Hero ──
  _factories["hero"] = function(d) {
    var r = el("div", {style: "padding:18px 16px;text-align:center;"});
    var iconEl = null;
    if (d.icon) { iconEl = el("div", {text: d.icon, style: "font-size:2rem;margin-bottom:8px;"}); r.appendChild(iconEl); }
    var titleEl = el("div", {text: d.title || "", style: "font-size:1.1rem;font-weight:700;color:#e4e4e7;"});
    r.appendChild(titleEl);
    var subEl = null;
    if (d.subtitle) { subEl = el("div", {text: d.subtitle, style: "font-size:0.82rem;color:#888;margin-top:4px;"}); r.appendChild(subEl); }
    var badgeEl = null;
    if (d.badge) { badgeEl = el("div", {text: d.badge, style: "display:inline-block;font-size:0.7rem;padding:2px 10px;border-radius:12px;background:#7c3aed22;color:#7c3aed;margin-top:8px;"}); r.appendChild(badgeEl); }
    return {el: r, update: function(nd) {
      if (nd.title != null) setText(titleEl, nd.title);
      if (nd.subtitle != null && subEl) setText(subEl, nd.subtitle);
      if (nd.icon != null && iconEl) setText(iconEl, nd.icon);
      if (nd.badge != null && badgeEl) setText(badgeEl, nd.badge);
    }};
  };

  // ── Alert ──
  _factories["alert"] = function(d) {
    var colors = {info: "#3b82f6", warning: "#f59e0b", error: "#ef4444", success: "#10b981"};
    var icons = {info: "ℹ", warning: "⚠", error: "✕", success: "✓"};
    var sev = d.severity || d.type || "info";
    var c = colors[sev] || colors.info;
    var r = el("div", {style: "padding:12px 14px;border-left:3px solid " + c + ";display:flex;gap:10px;align-items:flex-start;"});
    var iconWrap = el("div", {style: "width:20px;height:20px;border-radius:50%;background:" + c + "22;color:" + c + ";display:flex;align-items:center;justify-content:center;font-size:0.7rem;flex-shrink:0;"});
    var iconEl = document.createTextNode(icons[sev] || icons.info);
    iconWrap.appendChild(iconEl);
    r.appendChild(iconWrap);
    var body = el("div");
    var titleEl = el("div", {text: d.title || "", style: "font-size:0.82rem;font-weight:600;margin-bottom:2px;"});
    var msgEl = el("div", {text: d.message || d.text || "", style: "font-size:0.78rem;color:#999;line-height:1.4;"});
    body.appendChild(titleEl);
    body.appendChild(msgEl);
    r.appendChild(body);
    return {el: r, update: function(nd) {
      if (nd.title != null) setText(titleEl, nd.title);
      if (nd.message != null || nd.text != null) setText(msgEl, nd.message || nd.text || "");
      if (nd.severity && nd.severity !== sev) {
        sev = nd.severity;
        c = colors[sev] || colors.info;
        r.style.borderLeftColor = c;
        iconWrap.style.background = c + "22";
        iconWrap.style.color = c;
        iconEl.textContent = icons[sev] || icons.info;
      }
    }};
  };

  // ── Sparkline ──
  _factories["sparkline"] = function(d) {
    var r = el("div", {style: "padding:12px 16px;display:flex;align-items:center;gap:12px;"});
    var valWrap = el("div");
    var valEl = el("div", {text: String(d.value || ""), style: "font-size:1.1rem;font-weight:600;color:#ddd;"});
    var lblEl = el("div", {text: String(d.label || ""), style: "font-size:0.7rem;color:#888;"});
    valWrap.appendChild(valEl);
    valWrap.appendChild(lblEl);
    r.appendChild(valWrap);
    var svgNS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", "0 0 80 28");
    svg.style.cssText = "width:80px;height:28px;";
    var polyline = document.createElementNS(svgNS, "polyline");
    polyline.setAttribute("fill", "none");
    polyline.setAttribute("stroke", d.color || "#10b981");
    polyline.setAttribute("stroke-width", "1.5");
    polyline.setAttribute("stroke-linejoin", "round");
    function makePoints(pts) {
      if (!pts || pts.length < 2) return "";
      var min = Math.min.apply(null, pts), max = Math.max.apply(null, pts);
      if (max === min) max = min + 1;
      var coords = [];
      for (var i = 0; i < pts.length; i++) {
        var x = (i / (pts.length - 1)) * 80;
        var y = 2 + (1 - (pts[i] - min) / (max - min)) * 24;
        coords.push(x.toFixed(1) + "," + y.toFixed(1));
      }
      return coords.join(" ");
    }
    polyline.setAttribute("points", makePoints(d.points || d.values || []));
    svg.appendChild(polyline);
    r.appendChild(svg);
    var trendEl = null;
    if (d.trend) {
      trendEl = el("div", {text: String(d.trend), style: "font-size:0.75rem;color:" + (String(d.trend).startsWith("-") ? "#ef4444" : "#10b981") + ";margin-left:auto;"});
      r.appendChild(trendEl);
    }
    return {el: r, update: function(nd) {
      if (nd.value != null) setText(valEl, String(nd.value));
      if (nd.label != null) setText(lblEl, String(nd.label));
      if (nd.points || nd.values) polyline.setAttribute("points", makePoints(nd.points || nd.values));
      if (nd.color) polyline.setAttribute("stroke", nd.color);
      if (nd.trend != null && trendEl) {
        setText(trendEl, String(nd.trend));
        trendEl.style.color = String(nd.trend).startsWith("-") ? "#ef4444" : "#10b981";
      }
    }};
  };

  // ── Card ──
  _factories["card"] = function(d) {
    var _richText = (typeof window !== "undefined" && window._scratchyRichText) || function(s) { return s || ""; };
    var r = el("div", {style: "padding:14px 16px;"});
    // If card has an action, make it clickable
    if (d.action) {
      r.style.cssText += "cursor:pointer;transition:background 0.15s;";
      r.setAttribute("data-sui-send", d.action);
      if (d.context) { r.setAttribute("data-sui-context", JSON.stringify(d.context)); }
      r.onmouseover = function() { r.style.background = "rgba(124,58,237,0.08)"; };
      r.onmouseout = function() { r.style.background = "transparent"; };
    }
    var hdr = el("div", {style: "display:flex;align-items:center;margin-bottom:8px;"});
    var iconEl = null;
    if (d.icon) {
      iconEl = el("span", {text: d.icon, style: "font-size:1.2rem;margin-right:8px;"});
      hdr.appendChild(iconEl);
    }
    var titleEl = el("span", {text: d.title || "", style: "font-size:0.9rem;font-weight:600;flex:1;"});
    hdr.appendChild(titleEl);
    // 3-dots menu
    if (d.menu && Array.isArray(d.menu) && d.menu.length > 0) {
      var menuWrap = el("div", {style: "position:relative;margin-left:8px;"});
      var dots = el("button", {text: "⋮", style: "background:none;border:none;color:#888;font-size:1.2rem;cursor:pointer;padding:2px 6px;border-radius:4px;transition:background 0.15s;"});
      dots.onmouseover = function() { dots.style.background = "rgba(255,255,255,0.1)"; };
      dots.onmouseout = function() { dots.style.background = "none"; };
      var dropdown = el("div", {style: "display:none;position:absolute;right:0;top:100%;background:#1e1e2e;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:4px 0;min-width:140px;z-index:100;box-shadow:0 8px 24px rgba(0,0,0,0.4);"});
      d.menu.forEach(function(item) {
        var mi = el("div", {text: (item.icon || "") + " " + item.label, style: "padding:8px 14px;font-size:0.78rem;color:#ddd;cursor:pointer;transition:background 0.15s;"});
        mi.setAttribute("data-sui-send", item.action);
        if (item.context) { mi.setAttribute("data-sui-context", JSON.stringify(item.context)); }
        mi.onmouseover = function() { mi.style.background = "rgba(124,58,237,0.15)"; };
        mi.onmouseout = function() { mi.style.background = "transparent"; };
        dropdown.appendChild(mi);
      });
      dots.onclick = function(e) {
        e.stopPropagation();
        var open = dropdown.style.display === "block";
        dropdown.style.display = open ? "none" : "block";
        if (!open) {
          var close = function(ev) { if (!menuWrap.contains(ev.target)) { dropdown.style.display = "none"; document.removeEventListener("click", close); } };
          setTimeout(function() { document.addEventListener("click", close); }, 0);
        }
      };
      menuWrap.appendChild(dots); menuWrap.appendChild(dropdown);
      hdr.appendChild(menuWrap);
    }
    r.appendChild(hdr);
    var textEl = el("div", {style: "font-size:0.82rem;color:#aaa;line-height:1.5;"});
    textEl.innerHTML = _richText(d.text);
    r.appendChild(textEl);
    var _curText = d.text || "";
    return {el: r, update: function(nd) {
      if (nd.icon != null && iconEl) setText(iconEl, nd.icon);
      if (nd.title != null) setText(titleEl, nd.title);
      if (nd.text != null && nd.text !== _curText) {
        _curText = nd.text;
        var rt = (typeof window !== "undefined" && window._scratchyRichText) || function(s) { return s || ""; };
        textEl.innerHTML = rt(nd.text);
      }
    }};
  };

  // ── Stacked Bar ──
  _factories["stacked-bar"] = function(d) {
    var r=el("div",{style:"padding:14px 12px;"});
    var tl=null;
    if(d.title){tl=el("div",{text:d.title,style:"font-size:0.75rem;color:#888;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;"});r.appendChild(tl);}
    var bar=el("div",{style:"height:20px;border-radius:10px;overflow:hidden;display:flex;background:rgba(255,255,255,0.04);"});
    r.appendChild(bar);
    var leg=el("div",{style:"display:flex;flex-wrap:wrap;gap:10px;margin-top:6px;"});r.appendChild(leg);
    var colors=["#7c3aed","#e94560","#3b82f6","#10b981","#f59e0b"];
    function build(items){
      bar.innerHTML="";leg.innerHTML="";
      var total=(items||[]).reduce(function(s,it){return s+(it.value||0);},0)||1;
      (items||[]).forEach(function(it,i){
        var c=it.color||colors[i%colors.length];
        var pct=((it.value||0)/total*100).toFixed(1);
        var seg=el("div");seg.style.cssText="width:"+pct+"%;height:100%;background:"+c+";transition:width 0.5s ease;";
        bar.appendChild(seg);
        var le=el("div",{style:"display:flex;align-items:center;gap:4px;font-size:0.7rem;"});
        var dot=el("span");dot.style.cssText="width:8px;height:8px;border-radius:2px;background:"+c+";display:inline-block;";
        var lbl=el("span",{text:it.label||"",style:"color:#888;"});
        var val=el("span",{text:String(it.value||""),style:"color:#aaa;"});
        le.appendChild(dot);le.appendChild(lbl);le.appendChild(val);leg.appendChild(le);
      });
    }
    build(d.items);
    return {el:r,update:function(d){
      if(d.title!=null&&tl)setText(tl,d.title);
      if(d.items)build(d.items);
    }};
  };

  // ── Form Strip ──
  _factories["form-strip"] = function(d) {
    var r=el("div",{style:"padding:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;"});
    var action=d.action||d.label||"Submit";
    function build(fields){
      r.innerHTML="";(fields||[]).forEach(function(f){
        var inp=document.createElement("input");inp.type=f.type||"text";inp.placeholder=f.placeholder||f.label||"";
        inp.style.cssText="flex:1;min-width:100px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1);color:#e4e4e7;border-radius:6px;padding:6px 10px;font-size:0.8rem;outline:none;";
        r.appendChild(inp);
      });
      var btn=document.createElement("button");btn.textContent=action;btn.setAttribute("data-sui-send",action);
      btn.style.cssText="padding:6px 14px;border-radius:6px;border:none;background:#7c3aed;color:#fff;font-size:0.78rem;cursor:pointer;white-space:nowrap;";
      r.appendChild(btn);
    }
    build(d.fields);
    return {el:r,update:function(d){
      if(d.action)action=d.action;
      if(d.fields)build(d.fields);
    }};
  };

  // ── Link Card ──
  _factories["link-card"] = function(d) {
    var r=el("div",{style:"padding:14px 16px;"});
    var ic=el("div",{text:d.icon||"",style:"font-size:1.2rem;margin-bottom:6px;"});
    var ti=el("div",{text:d.title||"",style:"font-size:0.85rem;font-weight:500;color:#ddd;"});
    var ds=el("div",{text:d.desc||d.description||"",style:"font-size:0.78rem;color:#888;margin-top:4px;"});
    var lnk=document.createElement("a");lnk.href=d.url||"#";lnk.target=d.target||"_blank";lnk.rel="noopener";lnk.textContent="Open →";
    lnk.style.cssText="display:inline-block;margin-top:8px;font-size:0.72rem;color:#7c3aed;text-decoration:none;";
    if(!d.url)lnk.style.display="none";
    r.appendChild(ic);r.appendChild(ti);r.appendChild(ds);r.appendChild(lnk);
    return {el:r,update:function(d){
      if(d.icon!=null)setText(ic,d.icon);if(d.title!=null)setText(ti,d.title);
      if(d.desc!=null||d.description!=null)setText(ds,d.desc||d.description||"");
      if(d.url!=null){lnk.href=d.url;lnk.style.display=d.url?"inline-block":"none";}
    }};
  };

  // ── Status ──
  _factories.status = function(d) {
    var r=el("div",{style:"padding:10px 16px;display:flex;align-items:center;gap:8px;"});
    var dot=el("div");dot.style.cssText="width:8px;height:8px;border-radius:50%;background:"+(d.color||"#10b981")+";transition:background 0.3s ease;";
    var tx=el("span",{text:d.text||"",style:"font-size:0.82rem;color:#ddd;"});
    r.appendChild(dot);r.appendChild(tx);
    return {el:r,update:function(d){
      if(d.color)dot.style.background=d.color;
      if(d.text!=null)setText(tx,d.text);
    }};
  };

  // ── Streak ──
  _factories.streak = function(d) {
    var r=el("div",{style:"padding:14px 12px;"});
    var tl=null;
    if(d.title){tl=el("div",{text:d.title,style:"font-size:0.75rem;color:#888;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px;"});r.appendChild(tl);}
    var gr=el("div",{style:"display:flex;gap:6px;justify-content:center;"});r.appendChild(gr);
    function build(days,active){
      gr.innerHTML="";(days||[]).forEach(function(day,i){
        var on=active&&active[i];
        var col=el("div",{style:"display:flex;flex-direction:column;align-items:center;gap:4px;"});
        var box=el("div",{text:on?"✓":"",style:"width:28px;height:28px;border-radius:6px;background:"+(on?"#10b981":"rgba(255,255,255,0.06)")+";display:flex;align-items:center;justify-content:center;font-size:0.7rem;color:#fff;transition:background 0.3s ease;"});
        var lbl=el("span",{text:day,style:"font-size:0.65rem;color:"+(on?"#fff":"#555")+";"});
        col.appendChild(box);col.appendChild(lbl);gr.appendChild(col);
      });
    }
    build(d.days,d.active);
    return {el:r,update:function(d){
      if(d.title!=null&&tl)setText(tl,d.title);
      if(d.days||d.active)build(d.days,d.active);
    }};
  };

  // ── Rating ──
  _factories.rating = function(d) {
    var r=el("div",{style:"padding:14px 12px;text-align:center;"});
    var tl=null;
    if(d.title){tl=el("div",{text:d.title,style:"font-size:0.75rem;color:#888;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;"});r.appendChild(tl);}
    var sg=el("div");r.appendChild(sg);var stars=[];
    function build(val,max){
      sg.innerHTML="";stars=[];max=max||5;
      for(var i=1;i<=max;i++){
        var s=el("span",{text:"★",style:"font-size:1.3rem;color:"+(i<=val?"#f59e0b":"#333")+";transition:color 0.3s ease;"});
        sg.appendChild(s);stars.push(s);
      }
    }
    build(d.value||0,d.max||5);
    return {el:r,update:function(d){
      if(d.title!=null&&tl)setText(tl,d.title);
      if(d.value!=null||d.max!=null){
        var v=d.value!=null?d.value:(stars.filter(function(s){return s.style.color==="rgb(245, 158, 11)";}).length);
        var m=d.max||stars.length||5;
        if(m!==stars.length)build(v,m);
        else for(var i=0;i<stars.length;i++)stars[i].style.color=i<v?"#f59e0b":"#333";
      }
    }};
  };

  // ── Chips ──
  _factories.chips = function(d) {
    var r=el("div",{style:"padding:14px 12px;"});
    var tl=null;
    if(d.title){tl=el("div",{text:d.title,style:"font-size:0.75rem;color:#888;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;"});r.appendChild(tl);}
    var gr=el("div",{style:"display:flex;flex-wrap:wrap;gap:2px;"});r.appendChild(gr);
    function build(chips){
      gr.innerHTML="";(chips||[]).forEach(function(c){
        var label=typeof c==="string"?c:(c.text||c.label||"");
        var color=(typeof c==="object"&&c.color)?c.color:"#7c3aed";
        var checked=typeof c==="object"&&c.checked;
        var bg=checked?color+"44":color+"22";
        var border=checked?color+"88":color+"33";
        var fw=checked?"600":"400";
        var sp=el("span",{text:label,style:"display:inline-block;padding:4px 12px;border-radius:20px;font-size:0.75rem;font-weight:"+fw+";background:"+bg+";color:"+color+";border:1px solid "+border+";margin:3px;cursor:pointer;transition:background 0.15s ease,border-color 0.15s ease;"});
        if(c.value){sp.dataset.suiSend=c.value;}
        gr.appendChild(sp);
      });
    }
    build(d.chips);
    return {el:r,update:function(d){
      if(d.title!=null&&tl)setText(tl,d.title);
      if(d.chips)build(d.chips);
    }};
  };

  // ── Toggle ──
  _factories.toggle = function(d) {
    var r=el("div",{style:"padding:12px 14px;display:flex;align-items:center;justify-content:space-between;"});
    var lb=el("span",{text:d.label||d.title||"",style:"font-size:0.82rem;color:#ddd;"});
    var track=el("div");var _on=!!(d.value||d.checked);
    track.style.cssText="width:44px;height:24px;border-radius:12px;background:"+(_on?"#10b981":"rgba(255,255,255,0.15)")+";position:relative;transition:background 0.2s;cursor:pointer;";
    var thumb=el("div");thumb.style.cssText="width:20px;height:20px;border-radius:50%;background:#fff;position:absolute;top:2px;transition:left 0.2s;left:"+(_on?"22px":"2px")+";";
    track.appendChild(thumb);track.setAttribute("data-sui-send","toggle "+(d.id||d.label||""));
    r.appendChild(lb);r.appendChild(track);
    return {el:r,update:function(d){
      if(d.label!=null||d.title!=null)setText(lb,d.label||d.title||"");
      if(d.value!=null||d.checked!=null){_on=!!(d.value||d.checked);track.style.background=_on?"#10b981":"rgba(255,255,255,0.15)";thumb.style.left=_on?"22px":"2px";}
    }};
  };

  // ── Input ──
  _factories.input = function(d) {
    var r=el("div",{style:"padding:12px 14px;"});
    var lb=null;
    if(d.label){lb=el("div",{text:d.label,style:"font-size:0.72rem;color:#888;margin-bottom:4px;"});r.appendChild(lb);}
    var inp=document.createElement("input");inp.type=d.type||"text";inp.placeholder=d.placeholder||"";inp.value=d.value||"";
    inp.style.cssText="width:100%;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1);color:#e4e4e7;border-radius:6px;padding:8px 12px;font-size:0.82rem;outline:none;box-sizing:border-box;transition:border-color 0.2s;";
    inp.onfocus=function(){inp.style.borderColor="rgba(124,58,237,0.5)";};
    inp.onblur=function(){inp.style.borderColor="rgba(255,255,255,0.1)";};
    r.appendChild(inp);
    return {el:r,update:function(d){
      if(d.label!=null&&lb)setText(lb,d.label);
      if(d.placeholder!=null)inp.placeholder=d.placeholder;
      if(d.value!=null)inp.value=d.value;
    }};
  };

  // ── Slider ──
  _factories.slider = function(d) {
    var r=el("div",{style:"padding:12px 14px;"});
    var hd=el("div",{style:"display:flex;justify-content:space-between;margin-bottom:4px;"});
    var lb=el("span",{text:d.label||d.title||"",style:"font-size:0.75rem;color:#888;"});
    var vl=el("span",{text:String(d.value||50),style:"font-size:0.75rem;color:#ddd;"});
    hd.appendChild(lb);hd.appendChild(vl);r.appendChild(hd);
    var sl=document.createElement("input");sl.type="range";sl.min=d.min||0;sl.max=d.max||100;sl.value=d.value||50;
    sl.style.cssText="width:100%;accent-color:#7c3aed;";
    sl.oninput=function(){setText(vl,sl.value);};
    r.appendChild(sl);
    return {el:r,update:function(d){
      if(d.label!=null||d.title!=null)setText(lb,d.label||d.title||"");
      if(d.value!=null){sl.value=d.value;setText(vl,String(d.value));}
      if(d.min!=null)sl.min=d.min;if(d.max!=null)sl.max=d.max;
    }};
  };

  // ── Tabs ──
  _factories.tabs = function(d) {
    var r=el("div");
    var tl=null;
    if(d.title){tl=el("div",{text:d.title,style:"padding:12px 14px 0;font-size:0.75rem;color:#888;text-transform:uppercase;letter-spacing:0.05em;"});r.appendChild(tl);}
    var bar=el("div",{style:"display:flex;border-bottom:1px solid rgba(255,255,255,0.06);padding:0 8px;"});
    r.appendChild(bar);
    var body=el("div",{style:"padding:12px;font-size:0.82rem;color:#bbb;"});
    r.appendChild(body);
    var _active=d.active||0;
    function build(tabs,active){
      bar.innerHTML="";_active=active||0;
      (tabs||[]).forEach(function(t,i){
        var label=typeof t==="string"?t:t.label;
        var tab=el("div",{text:label,style:"padding:8px 16px;font-size:0.8rem;cursor:pointer;border-bottom:2px solid "+(i===_active?"#7c3aed":"transparent")+";color:"+(i===_active?"#fff":"#888")+";transition:all 0.2s;"});
        tab.onclick=function(){_active=i;build(tabs,i);};
        bar.appendChild(tab);
      });
      var ct=tabs&&tabs[_active];
      body.textContent=(ct&&typeof ct==="object"&&ct.content)?ct.content:"";
    }
    build(d.tabs,d.active);
    return {el:r,update:function(d){
      if(d.title!=null&&tl)setText(tl,d.title);
      if(d.tabs)build(d.tabs,d.active||0);
      else if(d.active!=null)build(d.tabs,d.active);
    }};
  };

  // ── Video ──
  _factories.video = function(d) {
    var r=el("div",{style:"padding:8px;"});
    var tl=null;
    if(d.title){tl=el("div",{text:d.title,style:"font-size:0.75rem;color:#888;padding:4px 6px;"});r.appendChild(tl);}
    var vid=document.createElement("video");vid.controls=true;vid.preload="metadata";vid.style.cssText="width:100%;border-radius:6px;";
    vid.src=d.url||d.src||"";r.appendChild(vid);
    return {el:r,update:function(d){
      if(d.title!=null&&tl)setText(tl,d.title);
      if(d.url!=null||d.src!=null)vid.src=d.url||d.src||"";
    }};
  };

  // ── Image ──
  _factories.image = function(d) {
    var r=el("div",{style:"padding:8px;"});
    var tl=null;
    if(d.title||d.caption){tl=el("div",{text:d.title||d.caption||"",style:"font-size:0.75rem;color:#888;padding:4px 6px;"});r.appendChild(tl);}
    var img=document.createElement("img");img.src=d.url||d.src||"";img.alt=d.alt||d.title||"";img.loading="lazy";
    img.style.cssText="width:100%;border-radius:6px;display:block;";r.appendChild(img);
    return {el:r,update:function(d){
      if(d.title!=null||d.caption!=null){if(tl)setText(tl,d.title||d.caption||"");}
      if(d.url!=null||d.src!=null)img.src=d.url||d.src||"";
      if(d.alt!=null)img.alt=d.alt;
    }};
  };

  // ── Form ──
  _factories.form = function(d) {
    var r=el("div",{style:"padding:14px 16px;"});
    var tl=null;
    if(d.title){tl=el("div",{text:d.title,style:"font-size:0.75rem;color:#888;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px;"});r.appendChild(tl);}
    var form=document.createElement("form");form.onsubmit=function(){return false;};
    r.appendChild(form);
    var formId=d.id||("form-"+Math.random().toString(36).substr(2,9));
    function buildField(f){
      var wrap=el("div",{style:"margin-bottom:10px;"});
      var labelStyle="font-size:0.75rem;color:#888;margin-bottom:4px;display:block;";
      var inputStyle="background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1);color:#e4e4e7;border-radius:6px;padding:8px 12px;font-size:0.82rem;width:100%;box-sizing:border-box;outline:none;transition:border-color 0.2s;";
      if(f.type==="hidden"){var hid=document.createElement("input");hid.type="hidden";hid.name=f.name||"";hid.value=f.value||"";wrap.appendChild(hid);wrap.style.display="none";return wrap;}
      if(f.label&&f.type!=="checkbox"){var lbl=el("label",{text:f.label,style:labelStyle});wrap.appendChild(lbl);}
      if(f.type==="textarea"||f.type==="richtext"){
        var isRich=f.type==="richtext";
        var ta=document.createElement("textarea");ta.name=f.name||"";ta.value=f.value||"";ta.placeholder=f.placeholder||"";if(f.required)ta.required=true;ta.setAttribute("data-label",f.label||f.name||"");
        var contentLines=((f.value||"").match(/\n/g)||[]).length+1;
        var minRows=isRich?12:(f.rows||6);
        ta.rows=Math.max(minRows, Math.min(contentLines+2, 30));
        var minH=isRich?"300px":"100px";
        ta.style.cssText=inputStyle+"font-family:'Fira Code',Consolas,monospace;resize:vertical;min-height:"+minH+";line-height:1.6;font-size:0.8rem;tab-size:2;";
        ta.onfocus=function(){ta.style.borderColor="rgba(124,58,237,0.5)";};ta.onblur=function(){ta.style.borderColor="rgba(255,255,255,0.1)";};

        if(isRich && typeof renderMarkdown==="function"){
          // ── Markdown editor with tabs: Edit | Preview ──
          var editorWrap=el("div",{style:"border:1px solid rgba(255,255,255,0.1);border-radius:8px;overflow:hidden;"});
          var tabBar=el("div",{style:"display:flex;border-bottom:1px solid rgba(255,255,255,0.08);background:rgba(0,0,0,0.2);"});
          var tabEdit=el("button",{text:"✏️ Edit",style:"flex:1;padding:8px;background:rgba(124,58,237,0.15);color:#c4b5fd;border:none;cursor:pointer;font-size:0.78rem;border-bottom:2px solid #7c3aed;"});
          var tabPreview=el("button",{text:"👁️ Preview",style:"flex:1;padding:8px;background:transparent;color:#888;border:none;cursor:pointer;font-size:0.78rem;border-bottom:2px solid transparent;"});
          tabBar.appendChild(tabEdit);tabBar.appendChild(tabPreview);
          editorWrap.appendChild(tabBar);

          var editPane=el("div",{style:"display:block;"});
          ta.style.cssText+=";border:none;border-radius:0;width:100%;box-sizing:border-box;";
          editPane.appendChild(ta);

          var previewPane=el("div",{style:"display:none;padding:16px;min-height:"+minH+";max-height:500px;overflow-y:auto;color:#ccc;font-size:0.82rem;line-height:1.6;"});

          editorWrap.appendChild(editPane);
          editorWrap.appendChild(previewPane);

          var activeTab="edit";
          function switchTab(tab){
            activeTab=tab;
            if(tab==="edit"){
              editPane.style.display="block";previewPane.style.display="none";
              tabEdit.style.background="rgba(124,58,237,0.15)";tabEdit.style.color="#c4b5fd";tabEdit.style.borderBottom="2px solid #7c3aed";
              tabPreview.style.background="transparent";tabPreview.style.color="#888";tabPreview.style.borderBottom="2px solid transparent";
            } else {
              editPane.style.display="none";previewPane.style.display="block";
              tabPreview.style.background="rgba(124,58,237,0.15)";tabPreview.style.color="#c4b5fd";tabPreview.style.borderBottom="2px solid #7c3aed";
              tabEdit.style.background="transparent";tabEdit.style.color="#888";tabEdit.style.borderBottom="2px solid transparent";
              // Render markdown preview
              previewPane.innerHTML=renderMarkdown(ta.value||"*Nothing to preview*");
              // Make links open in new tab
              var links=previewPane.querySelectorAll("a");for(var li=0;li<links.length;li++){links[li].target="_blank";links[li].rel="noopener";}
            }
          }
          tabEdit.onclick=function(){switchTab("edit");};
          tabPreview.onclick=function(){switchTab("preview");};

          // Tab key inserts spaces instead of changing focus
          ta.addEventListener("keydown",function(e){
            if(e.key==="Tab"){
              e.preventDefault();
              var start=ta.selectionStart,end=ta.selectionEnd;
              ta.value=ta.value.substring(0,start)+"  "+ta.value.substring(end);
              ta.selectionStart=ta.selectionEnd=start+2;
              ta.dispatchEvent(new Event("input"));
            }
          });

          wrap.appendChild(editorWrap);
        } else {
          wrap.appendChild(ta);
        }

        // Live character & word counter
        var counter=el("div",{style:"display:flex;gap:12px;font-size:0.7rem;color:#666;margin-top:4px;padding:0 2px;"});
        var charSpan=el("span",{text:"0 characters"});
        var wordSpan=el("span",{text:"0 words"});
        var lineSpan=el("span",{text:"1 line"});
        counter.appendChild(charSpan);counter.appendChild(wordSpan);counter.appendChild(lineSpan);
        wrap.appendChild(counter);
        var _updateCounter=function(){
          var v=ta.value||"";
          var chars=v.length;
          var words=v.trim()?v.trim().split(/\s+/).length:0;
          var lines=(v.match(/\n/g)||[]).length+1;
          charSpan.textContent=chars+" character"+(chars!==1?"s":"");
          wordSpan.textContent=words+" word"+(words!==1?"s":"");
          lineSpan.textContent=lines+" line"+(lines!==1?"s":"");
        };
        ta.addEventListener("input",_updateCounter);
        _updateCounter(); // init with existing value
      } else if(f.type==="select"){
        var sel=document.createElement("select");sel.name=f.name||"";if(f.required)sel.required=true;sel.setAttribute("data-label",f.label||f.name||"");sel.style.cssText=inputStyle+"appearance:none;cursor:pointer;";
        (f.options||[]).forEach(function(o){var opt=document.createElement("option");opt.value=typeof o==="object"?o.value:o;opt.textContent=typeof o==="object"?o.label:o;if(opt.value==f.value)opt.selected=true;opt.style.cssText="background:#222;color:#ddd;";sel.appendChild(opt);});
        wrap.appendChild(sel);
      } else if(f.type==="checkbox"){
        var cw=el("div",{style:"display:flex;align-items:center;gap:8px;"});
        var cb=document.createElement("input");cb.type="checkbox";cb.name=f.name||"";if(f.value)cb.checked=true;cb.style.cssText="accent-color:#7c3aed;width:16px;height:16px;cursor:pointer;";
        var cl=el("label",{text:f.label||"",style:"font-size:0.82rem;color:#ddd;cursor:pointer;user-select:none;"});
        cw.appendChild(cb);cw.appendChild(cl);wrap.appendChild(cw);
      } else {
        var validTypes={"number":1,"email":1,"password":1,"date":1,"time":1,"datetime-local":1,"tel":1,"url":1,"color":1};
        var inp=document.createElement("input");inp.type=validTypes[f.type]?f.type:"text";inp.name=f.name||"";inp.value=f.value||"";inp.placeholder=f.placeholder||"";
        if(f.required)inp.required=true;
        inp.setAttribute("data-label",f.label||f.name||"");
        inp.style.cssText=inputStyle;
        inp.onfocus=function(){inp.style.borderColor="rgba(124,58,237,0.5)";};inp.onblur=function(){inp.style.borderColor="rgba(255,255,255,0.1)";};
        // Block paste on secure fields (noPaste flag)
        if(f.noPaste){inp.addEventListener("paste",function(e){e.preventDefault();});inp.autocomplete="off";}
        wrap.appendChild(inp);
      }
      return wrap;
    }
    function buildActions(actions){
      var ag=el("div",{style:"display:flex;flex-wrap:wrap;gap:8px;margin-top:14px;"});
      (actions||[]).forEach(function(act){
        var btnLabel=typeof act==="object"?(act.label||act.action||""):String(act);
        var btnAction=typeof act==="object"?(act.action||act.label||""):String(act);
        var isPrimary=typeof act==="object"&&act.style==="primary";
        var btn=document.createElement("button");btn.type="button";btn.textContent=btnLabel;
        btn.setAttribute("data-sui-form",formId);btn.setAttribute("data-sui-send",btnAction);
        btn.style.cssText=isPrimary?"padding:6px 14px;border-radius:6px;border:none;background:#7c3aed;color:#fff;font-size:0.78rem;cursor:pointer;transition:background 0.15s;":"padding:6px 14px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.04);color:#ddd;font-size:0.78rem;cursor:pointer;transition:background 0.15s,border-color 0.15s;";
        if(isPrimary){btn.onmouseover=function(){btn.style.background="#6d28d9";};btn.onmouseout=function(){btn.style.background="#7c3aed";};}
        else{btn.onmouseover=function(){btn.style.background="rgba(124,58,237,0.15)";btn.style.borderColor="rgba(124,58,237,0.3)";};btn.onmouseout=function(){btn.style.background="rgba(255,255,255,0.04)";btn.style.borderColor="rgba(255,255,255,0.1)";};}
        ag.appendChild(btn);
      });
      return ag;
    }
    function buildForm(data){
      form.innerHTML="";
      (data.fields||[]).forEach(function(f){form.appendChild(buildField(f));});
      if(data.actions&&data.actions.length)form.appendChild(buildActions(data.actions));
    }
    buildForm(d);
    return {el:r,update:function(d){
      if(d.title!=null&&tl)setText(tl,d.title);
      if(d.fields||d.actions)buildForm(d);
    }};
  };

  // ── Chart Bar ──
  _factories["chart-bar"] = function(d) {
    var r=el("div",{style:"padding:14px 12px;"});
    var tl=null;
    if(d.title){tl=el("div",{text:d.title,style:"font-size:0.75rem;color:#888;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;"});r.appendChild(tl);}
    var svgNS="http://www.w3.org/2000/svg";
    var container=el("div");r.appendChild(container);
    var leg=el("div",{style:"margin-top:6px;"});r.appendChild(leg);
    function build(data){
      container.innerHTML="";leg.innerHTML="";
      var labels=data.labels||[];var datasets=data.datasets||[];
      if(!labels.length||!datasets.length)return;
      var allVals=[];datasets.forEach(function(ds){allVals=allVals.concat(ds.data||[]);});
      var maxVal=Math.max.apply(null,allVals)||1;
      var padL=50,padR=10,padT=10,padB=28;
      var barW=Math.max(12,Math.floor(220/labels.length/datasets.length));
      var groupW=barW*datasets.length+4;
      var svgW=padL+labels.length*(groupW+8)+padR;var svgH=170;var chartH=svgH-padT-padB;
      var svg=document.createElementNS(svgNS,"svg");svg.setAttribute("width","100%");svg.setAttribute("viewBox","0 0 "+svgW+" "+svgH);svg.setAttribute("preserveAspectRatio","xMidYMid meet");
      for(var s=0;s<=5;s++){
        var val=Math.round((maxVal/5)*s);var y=padT+chartH-(s/5)*chartH;
        var txt=document.createElementNS(svgNS,"text");txt.setAttribute("x",padL-6);txt.setAttribute("y",y+3);txt.setAttribute("fill","#555");txt.setAttribute("font-size","9");txt.setAttribute("text-anchor","end");txt.textContent=val>=1000?Math.round(val/1000)+"k":val;svg.appendChild(txt);
        var line=document.createElementNS(svgNS,"line");line.setAttribute("x1",padL);line.setAttribute("y1",y);line.setAttribute("x2",svgW-padR);line.setAttribute("y2",y);line.setAttribute("stroke","rgba(255,255,255,0.04)");svg.appendChild(line);
      }
      var labelSkip=labels.length>16?3:labels.length>10?2:1;
      labels.forEach(function(label,i){
        var gx=padL+4+i*(groupW+8);
        datasets.forEach(function(ds,j){
          var val=(ds.data||[])[i]||0;var h=(val/maxVal)*chartH;var c=ds.color||"#7c3aed";
          var rect=document.createElementNS(svgNS,"rect");rect.setAttribute("x",gx+j*(barW+1));rect.setAttribute("y",padT+chartH-h);rect.setAttribute("width",barW);rect.setAttribute("height",h);rect.setAttribute("rx","3");rect.setAttribute("fill",c);rect.setAttribute("opacity","0.85");
          rect.style.transition="height 0.5s ease, y 0.5s ease";svg.appendChild(rect);
        });
        if(i%labelSkip===0){var xt=document.createElementNS(svgNS,"text");xt.setAttribute("x",gx+groupW/2);xt.setAttribute("y",svgH-4);xt.setAttribute("fill","#666");xt.setAttribute("font-size","9");xt.setAttribute("text-anchor","middle");xt.textContent=label;svg.appendChild(xt);}
      });
      container.appendChild(svg);
      datasets.forEach(function(ds){
        var le=el("span",{style:"display:inline-flex;align-items:center;gap:4px;margin-right:10px;"});
        var dot=el("span");dot.style.cssText="width:8px;height:8px;border-radius:2px;background:"+(ds.color||"#7c3aed")+";display:inline-block;";
        var lbl=el("span",{text:ds.label||"",style:"font-size:0.7rem;color:#888;"});
        le.appendChild(dot);le.appendChild(lbl);leg.appendChild(le);
      });
    }
    build(d);
    return {el:r,update:function(d){if(d.title!=null&&tl)setText(tl,d.title);build(d);}};
  };

  // ── Chart Line ──
  _factories["chart-line"] = function(d) {
    var r=el("div",{style:"padding:14px 12px;"});
    var tl=null;
    if(d.title){tl=el("div",{text:d.title,style:"font-size:0.75rem;color:#888;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;"});r.appendChild(tl);}
    var svgNS="http://www.w3.org/2000/svg";
    var container=el("div");r.appendChild(container);
    var leg=el("div",{style:"margin-top:6px;"});r.appendChild(leg);
    function build(data){
      container.innerHTML="";leg.innerHTML="";
      var labels=data.labels||[];var datasets=data.datasets||[];
      if(!labels.length||!datasets.length)return;
      var allVals=[];datasets.forEach(function(ds){allVals=allVals.concat(ds.data||[]);});
      var maxVal=Math.max.apply(null,allVals)||1;
      var svgW=Math.max(300,labels.length*50+60);var svgH=160;
      var padL=50,padR=10,padT=10,padB=28;var chartW=svgW-padL-padR;var chartH=svgH-padT-padB;
      var svg=document.createElementNS(svgNS,"svg");svg.setAttribute("width","100%");svg.setAttribute("viewBox","0 0 "+svgW+" "+svgH);svg.setAttribute("preserveAspectRatio","xMidYMid meet");
      for(var s=0;s<=5;s++){
        var val=Math.round((maxVal/5)*s);var y=padT+chartH-(s/5)*chartH;
        var txt=document.createElementNS(svgNS,"text");txt.setAttribute("x",padL-6);txt.setAttribute("y",y+3);txt.setAttribute("fill","#555");txt.setAttribute("font-size","9");txt.setAttribute("text-anchor","end");txt.textContent=val>=1000?Math.round(val/1000)+"k":val;svg.appendChild(txt);
        var line=document.createElementNS(svgNS,"line");line.setAttribute("x1",padL);line.setAttribute("y1",y);line.setAttribute("x2",svgW-padR);line.setAttribute("y2",y);line.setAttribute("stroke","rgba(255,255,255,0.04)");svg.appendChild(line);
      }
      datasets.forEach(function(ds){
        var data_=ds.data||[];var c=ds.color||"#7c3aed";
        var pts=data_.map(function(v,i){return(padL+(i/(data_.length-1||1))*chartW)+","+(padT+chartH-(v/maxVal)*chartH);});
        var polygon=document.createElementNS(svgNS,"polygon");polygon.setAttribute("points",padL+","+(padT+chartH)+" "+pts.join(" ")+" "+(padL+chartW)+","+(padT+chartH));polygon.setAttribute("fill",c);polygon.setAttribute("opacity","0.08");svg.appendChild(polygon);
        var polyline=document.createElementNS(svgNS,"polyline");polyline.setAttribute("points",pts.join(" "));polyline.setAttribute("fill","none");polyline.setAttribute("stroke",c);polyline.setAttribute("stroke-width","2");polyline.setAttribute("stroke-linejoin","round");svg.appendChild(polyline);
        pts.forEach(function(pt){var xy=pt.split(",");var circ=document.createElementNS(svgNS,"circle");circ.setAttribute("cx",xy[0]);circ.setAttribute("cy",xy[1]);circ.setAttribute("r","3");circ.setAttribute("fill",c);svg.appendChild(circ);});
      });
      labels.forEach(function(label,i){
        var x=padL+(i/(labels.length-1||1))*chartW;
        var xt=document.createElementNS(svgNS,"text");xt.setAttribute("x",x);xt.setAttribute("y",svgH-4);xt.setAttribute("fill","#666");xt.setAttribute("font-size","9");xt.setAttribute("text-anchor","middle");xt.textContent=label;svg.appendChild(xt);
      });
      container.appendChild(svg);
      datasets.forEach(function(ds){
        var le=el("span",{style:"display:inline-flex;align-items:center;gap:4px;margin-right:10px;"});
        var dot=el("span");dot.style.cssText="width:8px;height:3px;border-radius:2px;background:"+(ds.color||"#7c3aed")+";display:inline-block;";
        var lbl=el("span",{text:ds.label||"",style:"font-size:0.7rem;color:#888;"});
        le.appendChild(dot);le.appendChild(lbl);leg.appendChild(le);
      });
    }
    build(d);
    return {el:r,update:function(d){if(d.title!=null&&tl)setText(tl,d.title);build(d);}};
  };

  // ── Chart Pie ──
  _factories["chart-pie"] = function(d) {
    var r=el("div",{style:"padding:14px 12px;"});
    var tl=null;
    if(d.title){tl=el("div",{text:d.title,style:"font-size:0.75rem;color:#888;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;"});r.appendChild(tl);}
    var row=el("div",{style:"display:flex;align-items:center;gap:16px;"});r.appendChild(row);
    var svgNS="http://www.w3.org/2000/svg";
    var svg=document.createElementNS(svgNS,"svg");svg.setAttribute("width","120");svg.setAttribute("height","120");svg.setAttribute("viewBox","0 0 120 120");svg.style.transform="rotate(-90deg)";
    row.appendChild(svg);
    var legend=el("div",{style:"flex:1;"});row.appendChild(legend);
    var defColors=["#7c3aed","#e94560","#3b82f6","#10b981","#f59e0b","#ef4444","#8b5cf6","#06b6d4"];
    function build(items){
      svg.innerHTML="";legend.innerHTML="";
      var total=(items||[]).reduce(function(s,it){return s+(it.value||0);},0)||1;
      var cx=60,cy=60,radius=44,strokeW=14;var circ=2*Math.PI*radius;var offset=0;
      (items||[]).forEach(function(it,i){
        var frac=(it.value||0)/total;var segLen=frac*circ;var c=it.color||defColors[i%defColors.length];
        var circle=document.createElementNS(svgNS,"circle");circle.setAttribute("cx",cx);circle.setAttribute("cy",cy);circle.setAttribute("r",radius);circle.setAttribute("fill","none");circle.setAttribute("stroke",c);circle.setAttribute("stroke-width",strokeW);
        circle.style.strokeDasharray=segLen.toFixed(1)+" "+(circ-segLen).toFixed(1);circle.style.strokeDashoffset="-"+offset.toFixed(1);
        circle.style.transition="stroke-dasharray 0.6s ease, stroke-dashoffset 0.6s ease";circle.style.opacity="0.9";
        svg.appendChild(circle);offset+=segLen;
        var le=el("div",{style:"display:flex;align-items:center;gap:6px;margin:2px 0;"});
        var dot=el("span");dot.style.cssText="width:8px;height:8px;border-radius:2px;background:"+c+";flex-shrink:0;";
        var lbl=el("span",{text:it.label||"",style:"font-size:0.78rem;color:#bbb;"});
        var val=el("span",{text:String(it.value||""),style:"font-size:0.72rem;color:#666;margin-left:auto;"});
        le.appendChild(dot);le.appendChild(lbl);le.appendChild(val);legend.appendChild(le);
      });
    }
    build(d.items||d.slices||[]);
    return {el:r,update:function(d){
      if(d.title!=null&&tl)setText(tl,d.title);
      if(d.items||d.slices)build(d.items||d.slices||[]);
    }};
  };

  // ── Month Calendar ──
  _factories["month-calendar"] = function(d) {
    var r = el("div", {style: "padding:12px 8px;"});
    var _month = d.month != null ? d.month : new Date().getMonth();
    var _year = d.year != null ? d.year : new Date().getFullYear();
    var _events = d.events || {}; // { "2026-02-20": [{title, color}], ... }
    var _selected = d.selected || null; // "2026-02-20"
    var _actionPrefix = d.actionPrefix || "cal-day-select-";

    function build() {
      r.innerHTML = "";
      var months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
      var days = ["Mo","Tu","We","Th","Fr","Sa","Su"];

      // Header: ← Month Year →
      var hdr = el("div", {style: "display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;padding:0 4px;"});
      var prev = el("button", {text: "‹", style: "background:none;border:none;color:#aaa;font-size:1.4rem;cursor:pointer;padding:4px 10px;border-radius:6px;transition:background 0.15s;"});
      prev.onmouseover = function(){prev.style.background="rgba(255,255,255,0.08)";};
      prev.onmouseout = function(){prev.style.background="none";};
      var title = el("span", {text: months[_month] + " " + _year, style: "font-size:0.95rem;font-weight:600;color:#e4e4e7;"});
      var next = el("button", {text: "›", style: "background:none;border:none;color:#aaa;font-size:1.4rem;cursor:pointer;padding:4px 10px;border-radius:6px;transition:background 0.15s;"});
      next.onmouseover = function(){next.style.background="rgba(255,255,255,0.08)";};
      next.onmouseout = function(){next.style.background="none";};

      prev.onclick = function(e) {
        e.stopPropagation();
        _month--; if (_month < 0) { _month = 11; _year--; }
        build();
        // Fire navigation action
        if (r.closest && r.closest('[data-component-id]')) {
          var wrapEl = r.closest('[data-component-id]');
          var cid = wrapEl.dataset.componentId;
        }
      };
      next.onclick = function(e) {
        e.stopPropagation();
        _month++; if (_month > 11) { _month = 0; _year++; }
        build();
      };
      hdr.appendChild(prev); hdr.appendChild(title); hdr.appendChild(next);
      r.appendChild(hdr);

      // Day headers
      var dhdr = el("div", {style: "display:grid;grid-template-columns:repeat(7,1fr);gap:2px;margin-bottom:4px;"});
      for (var i = 0; i < 7; i++) {
        dhdr.appendChild(el("div", {text: days[i], style: "text-align:center;font-size:0.65rem;color:#666;padding:4px 0;font-weight:500;"}));
      }
      r.appendChild(dhdr);

      // Calendar grid
      var grid = el("div", {style: "display:grid;grid-template-columns:repeat(7,1fr);gap:2px;"});
      var firstDay = new Date(_year, _month, 1).getDay();
      var startOffset = (firstDay + 6) % 7; // Monday = 0
      var daysInMonth = new Date(_year, _month + 1, 0).getDate();
      var today = new Date();
      var todayStr = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");

      // Empty cells for offset
      for (var i = 0; i < startOffset; i++) {
        grid.appendChild(el("div", {style: "padding:6px;"}));
      }

      // Day cells
      for (var day = 1; day <= daysInMonth; day++) {
        var dateStr = _year + "-" + String(_month + 1).padStart(2, "0") + "-" + String(day).padStart(2, "0");
        var cell = el("div", {style: "position:relative;text-align:center;padding:6px 2px;border-radius:8px;cursor:pointer;transition:background 0.15s;min-height:32px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;"});

        var isToday = dateStr === todayStr;
        var isSelected = dateStr === _selected;
        var hasEvents = _events[dateStr] && _events[dateStr].length > 0;

        if (isSelected) {
          cell.style.background = "rgba(124,58,237,0.3)";
          cell.style.border = "1px solid rgba(124,58,237,0.5)";
        } else if (isToday) {
          cell.style.background = "rgba(16,185,129,0.15)";
          cell.style.border = "1px solid rgba(16,185,129,0.3)";
        }

        var num = el("div", {text: String(day), style: "font-size:0.78rem;color:" + (isToday ? "#10b981" : isSelected ? "#c084fc" : "#ccc") + ";font-weight:" + (isToday || isSelected ? "700" : "400") + ";"});
        cell.appendChild(num);

        // Event dots
        if (hasEvents) {
          var dotRow = el("div", {style: "display:flex;gap:2px;justify-content:center;"});
          var evts = _events[dateStr];
          var maxDots = Math.min(evts.length, 3);
          for (var di = 0; di < maxDots; di++) {
            var dot = el("div");
            dot.style.cssText = "width:4px;height:4px;border-radius:50%;background:" + (evts[di].color || "#818cf8") + ";";
            dotRow.appendChild(dot);
          }
          if (evts.length > 3) {
            dotRow.appendChild(el("div", {text: "+", style: "font-size:0.5rem;color:#888;line-height:4px;"}));
          }
          cell.appendChild(dotRow);
        }

        // Click handler
        (function(ds) {
          cell.setAttribute("data-sui-send", _actionPrefix + ds);
          cell.onclick = function() {
            _selected = ds;
            // Rebuild to update selection highlight (action is handled by delegated click on data-sui-send)
            setTimeout(function() { build(); }, 50);
          };
        })(dateStr);

        cell.onmouseover = function() { if (!isSelected && !isToday) this.style.background = "rgba(255,255,255,0.06)"; };
        cell.onmouseout = function() { if (!isSelected && !isToday) this.style.background = "transparent"; };
        grid.appendChild(cell);
      }
      r.appendChild(grid);

      // Legend: event count for selected/today
      var focusDate = _selected || todayStr;
      var focusEvents = _events[focusDate] || [];
      if (focusEvents.length > 0) {
        var leg = el("div", {style: "margin-top:8px;padding:6px 8px;background:rgba(255,255,255,0.03);border-radius:6px;"});
        for (var ei = 0; ei < focusEvents.length; ei++) {
          var evLine = el("div", {style: "display:flex;align-items:center;gap:6px;padding:3px 0;"});
          var evDot = el("div"); evDot.style.cssText = "width:6px;height:6px;border-radius:50%;background:" + (focusEvents[ei].color || "#818cf8") + ";flex-shrink:0;";
          var evText = el("div", {text: focusEvents[ei].title || "Event", style: "font-size:0.75rem;color:#bbb;"});
          evLine.appendChild(evDot); evLine.appendChild(evText);
          leg.appendChild(evLine);
        }
        r.appendChild(leg);
      }
    }

    build();
    return {el: r, update: function(nd) {
      if (nd.month != null) _month = nd.month;
      if (nd.year != null) _year = nd.year;
      if (nd.events) _events = nd.events;
      if (nd.selected) _selected = nd.selected;
      if (nd.actionPrefix) _actionPrefix = nd.actionPrefix;
      build();
    }};
  };

  // ── Smart Widget ── (Phase 2: Web Workers)
  _factories["smart-widget"] = function(d) {
    var r = el("div", {style: "padding: 12px; border: 1px solid rgba(255,255,255,0.1); border-radius: 6px;"});
    var widget = null;
    var errorEl = null;
    var isDeploying = false;
    
    // Apply size class if specified
    var widgetSize = (d.config && d.config.size) || 'auto';
    if (widgetSize && widgetSize !== 'default') {
      r.setAttribute('data-widget-size', 'widget-' + widgetSize);
    }
    
    function createWidget() {
      if (isDeploying) return;
      isDeploying = true;
      
      // Clear any previous content
      r.innerHTML = "";
      if (errorEl) {
        errorEl = null;
      }
      
      // Show loading state
      var loadingEl = el("div", {
        text: "Loading widget...",
        style: "color: #888; font-size: 0.8rem; padding: 8px; text-align: center; opacity: 0.7;"
      });
      r.appendChild(loadingEl);
      
      // Try Web Worker runtime first, fallback to basic sandbox
      var runtime = window.WebWorkerRuntime ? 
        new WebWorkerRuntime(d, r) : 
        new SmartWidgetSandbox(d, r);
      
      // Deploy widget
      var deployment = runtime.deploy ? runtime.deploy() : Promise.resolve(runtime);
      
      deployment.then(function(deployedWidget) {
        isDeploying = false;
        // Remove loading indicator
        if (r.contains(loadingEl)) {
          r.removeChild(loadingEl);
        }
        
        widget = deployedWidget;
        console.log('[SmartWidget] Deployed successfully using:', 
          window.WebWorkerRuntime ? 'Web Workers' : 'Basic Sandbox');
        
      }).catch(function(error) {
        isDeploying = false;
        console.error('[SmartWidget] Deployment failed:', error);
        
        // Remove loading indicator
        if (r.contains(loadingEl)) {
          r.removeChild(loadingEl);
        }
        
        // Try fallback to basic sandbox if Web Worker failed
        if (window.WebWorkerRuntime && !widget) {
          console.log('[SmartWidget] Falling back to basic sandbox...');
          try {
            var fallbackSandbox = new SmartWidgetSandbox(d, r);
            widget = fallbackSandbox.deploy();
          } catch (fallbackError) {
            showError(fallbackError.message || error.message);
          }
        } else {
          showError(error.message);
        }
      });
    }
    
    function showError(message) {
      errorEl = el("div", {
        style: "color: #ef4444; font-size: 0.8rem; padding: 8px; background: rgba(239,68,68,0.1); border-radius: 4px;"
      });
      errorEl.innerHTML = "<strong>Widget Error:</strong><br>" + message;
      r.appendChild(errorEl);
    }
    
    // Initialize widget
    createWidget();
    
    return {
      el: r,
      update: function(newData) {
        // Destroy current widget first
        if (widget && widget.destroy) {
          widget.destroy();
        }
        widget = null;
        
        // Update data and recreate
        d = newData;
        createWidget();
      },
      destroy: function() {
        if (widget && widget.destroy) {
          widget.destroy();
        }
        widget = null;
      }
    };
  };

  // ── Email View — single-tile email reader with inline HTML ──
  _factories["email-view"] = function(d) {
    var r = el("div", {style:"padding:0;max-height:80vh;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;width:100%;box-sizing:border-box;"});

    function render(d) {
      r.innerHTML = "";

      // Header
      var hdr = el("div", {style:"padding:16px 16px 12px;border-bottom:1px solid rgba(255,255,255,0.06);"});
      var subj = el("div", {style:"font-size:1rem;font-weight:600;color:#eee;margin-bottom:6px;"});
      subj.textContent = d.subject || "(No subject)";
      var meta = el("div", {style:"font-size:0.78rem;color:#999;"});
      meta.textContent = (d.from || "") + (d.date ? "  ·  " + d.date : "");
      hdr.appendChild(subj);
      hdr.appendChild(meta);
      if (d.to) {
        var toLine = el("div", {style:"font-size:0.72rem;color:#777;margin-top:2px;"});
        toLine.textContent = "To: " + d.to;
        hdr.appendChild(toLine);
      }
      r.appendChild(hdr);

      // Action buttons — on top for quick access
      if (d.actions && d.actions.length) {
        var acts = el("div", {style:"padding:8px 16px;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;flex-wrap:wrap;gap:6px;"});
        d.actions.forEach(function(btn){
          var b = el("button", {text:btn.label||"",style:
            "padding:6px 12px;border-radius:8px;font-size:0.75rem;cursor:pointer;border:none;transition:background 0.15s;" +
            (btn.style==="primary"
              ? "background:#7c3aed;color:#fff;"
              : "background:rgba(255,255,255,0.06);color:#ccc;")
          });
          b.setAttribute("data-sui-send", btn.action);
          b.onmouseover=function(){b.style.opacity="0.8";};
          b.onmouseout=function(){b.style.opacity="1";};
          acts.appendChild(b);
        });
        r.appendChild(acts);
      }

      // Attachments
      if (d.attachments && d.attachments.length) {
        var attWrap = el("div", {style:"padding:8px 16px;border-bottom:1px solid rgba(255,255,255,0.06);"});
        var attLabel = el("div", {style:"font-size:0.72rem;color:#999;margin-bottom:6px;"});
        attLabel.textContent = "📎 " + d.attachments.length + " attachment" + (d.attachments.length > 1 ? "s" : "");
        attWrap.appendChild(attLabel);
        var attChips = el("div", {style:"display:flex;flex-wrap:wrap;gap:6px;"});
        d.attachments.forEach(function(att) {
          var isPreviewable = att.mimeType && (att.mimeType.startsWith("image/") || att.mimeType === "application/pdf");
          var chip = el("div", {style:
            "display:inline-flex;align-items:center;gap:6px;padding:6px 10px;" +
            "background:rgba(124,58,237,0.12);border:1px solid rgba(124,58,237,0.25);border-radius:8px;" +
            "font-size:0.75rem;color:#c4b5fd;cursor:pointer;transition:background 0.15s;"
          });
          chip.onmouseover = function(){chip.style.background="rgba(124,58,237,0.25)";};
          chip.onmouseout = function(){chip.style.background="rgba(124,58,237,0.12)";};
          var icon = att.mimeType.startsWith("image/") ? "🖼️" :
                     att.mimeType.includes("pdf") ? "📄" :
                     att.mimeType.includes("zip") || att.mimeType.includes("rar") ? "📦" :
                     att.mimeType.includes("sheet") || att.mimeType.includes("csv") ? "📊" :
                     att.mimeType.includes("doc") || att.mimeType.includes("word") ? "📝" : "📁";
          var nameSpan = document.createElement("span");
          nameSpan.style.cssText = "color:#eee;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
          nameSpan.textContent = att.name || "file";
          var sizeSpan = document.createElement("span");
          sizeSpan.style.cssText = "color:#888;font-size:0.68rem;";
          sizeSpan.textContent = att.size || "";
          chip.appendChild(document.createTextNode(icon + " "));
          chip.appendChild(nameSpan);
          chip.appendChild(document.createTextNode(" "));
          chip.appendChild(sizeSpan);

          // Download button
          if (att.downloadUrl) {
            var dlBtn = el("span", {text:"⬇️", style:"cursor:pointer;margin-left:4px;font-size:0.7rem;opacity:0.7;"});
            dlBtn.title = "Download";
            dlBtn.onclick = function(e) {
              e.stopPropagation();
              fetchBlob(att.downloadUrl, function(err, blob) {
                if (err || !blob) return;
                triggerDownload(URL.createObjectURL(blob), att.name);
              });
            };
            chip.appendChild(dlBtn);
          }

          // Fetch attachment as blob (sends cookies automatically)
          function fetchBlob(url, cb) {
            var xhr = new XMLHttpRequest();
            xhr.open("GET", url, true);
            xhr.responseType = "blob";
            xhr.withCredentials = true;
            xhr.onload = function() {
              if (xhr.status === 200) cb(null, xhr.response);
              else cb(new Error("HTTP " + xhr.status));
            };
            xhr.onerror = function() { cb(new Error("Network error")); };
            xhr.send();
          }

          function triggerDownload(blobUrl, name) {
            var a = document.createElement("a");
            a.href = blobUrl;
            a.download = name || "attachment";
            a.style.display = "none";
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          }

          // Click to preview
          chip.onclick = function() {
            var url = att.previewUrl || att.downloadUrl;
            if (!url) return;

            if (isPreviewable) {
              // Show preview overlay with loading state
              var overlay = document.createElement("div");
              overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;";
              overlay.onclick = function(e) { if (e.target === overlay) { overlay.remove(); } };

              var toolbar = document.createElement("div");
              toolbar.style.cssText = "display:flex;gap:12px;margin-bottom:12px;align-items:center;";
              var nameLabel = el("span", {text: att.name || "file", style: "color:#ccc;font-size:0.85rem;"});
              var sizeLabel = el("span", {text: att.size || "", style: "color:#666;font-size:0.75rem;"});
              var downloadBtn = el("button", {text:"⬇️ Download", style:"padding:8px 16px;border-radius:8px;background:#7c3aed;color:#fff;border:none;cursor:pointer;font-size:0.85rem;"});
              var closeBtn = el("button", {text:"✕ Close", style:"padding:8px 16px;border-radius:8px;background:rgba(255,255,255,0.1);color:#fff;border:none;cursor:pointer;font-size:0.85rem;"});
              closeBtn.onclick = function() { overlay.remove(); };
              toolbar.appendChild(nameLabel);
              toolbar.appendChild(sizeLabel);
              toolbar.appendChild(downloadBtn);
              toolbar.appendChild(closeBtn);
              overlay.appendChild(toolbar);

              var loading = el("div", {text:"⏳ Loading...", style:"color:#999;font-size:0.9rem;"});
              overlay.appendChild(loading);
              document.body.appendChild(overlay);

              // Close on Escape
              var escHandler = function(e) { if (e.key === "Escape") { overlay.remove(); document.removeEventListener("keydown", escHandler); }};
              document.addEventListener("keydown", escHandler);

              fetchBlob(url, function(err, blob) {
                if (err || !blob) {
                  loading.textContent = "❌ Failed to load attachment";
                  loading.style.color = "#f87171";
                  return;
                }
                var blobUrl = URL.createObjectURL(blob);
                loading.remove();

                downloadBtn.onclick = function() { triggerDownload(blobUrl, att.name); };

                if (att.mimeType.startsWith("image/")) {
                  var img = document.createElement("img");
                  img.src = blobUrl;
                  img.style.cssText = "max-width:90vw;max-height:80vh;border-radius:8px;object-fit:contain;";
                  img.alt = att.name || "";
                  overlay.appendChild(img);
                } else if (att.mimeType === "application/pdf") {
                  var iframe = document.createElement("iframe");
                  iframe.src = blobUrl;
                  iframe.style.cssText = "width:90vw;height:80vh;border:none;border-radius:8px;background:#fff;";
                  overlay.appendChild(iframe);
                }
              });
            } else {
              // Non-previewable — download via blob
              fetchBlob(att.downloadUrl || url, function(err, blob) {
                if (err || !blob) return;
                triggerDownload(URL.createObjectURL(blob), att.name);
              });
            }
          };

          attChips.appendChild(chip);
        });
        attWrap.appendChild(attChips);
        r.appendChild(attWrap);
      }

      // Body — render sanitized HTML in shadow DOM for isolation
      var bodyWrap = el("div", {style:"padding:14px 16px;"});
      if (d.html) {
        var shadow = bodyWrap.attachShadow ? bodyWrap.attachShadow({mode:"closed"}) : bodyWrap;
        var style = document.createElement("style");
        style.textContent = [
          ":host{all:initial;display:block;font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#ccc;font-size:0.82rem;line-height:1.6;overflow-x:hidden;word-break:break-word;}",
          "*{max-width:100%!important;box-sizing:border-box!important;}",
          "img{max-width:100%!important;height:auto!important;border-radius:6px;margin:8px 0;}",
          "a{color:#a78bfa;text-decoration:none;word-break:break-all;}",
          "a:hover{text-decoration:underline;}",
          "h1,h2,h3{font-size:0.95rem;color:#ddd;margin:12px 0 4px;}",
          "h4,h5,h6{font-size:0.85rem;color:#ccc;margin:8px 0 4px;}",
          "p,div{margin:4px 0;}",
          "ul,ol{padding-left:18px;margin:4px 0;}",
          "li{margin:2px 0;}",
          "table{border-collapse:collapse;width:100%!important;margin:6px 0;table-layout:fixed!important;}",
          "td,th{padding:4px 8px;border:1px solid rgba(255,255,255,0.08);font-size:0.8rem;overflow:hidden;word-wrap:break-word;}",
          "hr{border:none;border-top:1px solid rgba(255,255,255,0.1);margin:12px 0;}",
          "blockquote{border-left:3px solid #7c3aed;padding-left:10px;margin:6px 0;color:#aaa;}",
          "pre,code{white-space:pre-wrap!important;word-break:break-all;}"
        ].join("\n");
        shadow.appendChild(style);
        var content = document.createElement("div");
        // Sanitize: remove scripts, event handlers, forms
        var safe = d.html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, "")
          .replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, "")
          .replace(/<form[^>]*>[\s\S]*?<\/form>/gi, "")
          .replace(/<input[^>]*>/gi, "")
          .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, "");
        // Remove tracking pixels
        safe = safe.replace(/<img[^>]*(?:width=["']1|height=["']1|track\/open)[^>]*>/gi, "");
        // Strip fixed widths/min-widths that break mobile layout
        safe = safe.replace(/\s(width|min-width)\s*[:=]\s*["']?\d{3,}px/gi, " max-width:100%");
        safe = safe.replace(/style="[^"]*"/gi, function(m){
          return m.replace(/width\s*:\s*\d{3,}px/gi,"width:100%").replace(/min-width\s*:\s*\d{2,}px/gi,"min-width:0");
        });
        // Remove width attributes on tables/tds
        safe = safe.replace(/<(table|td|th|div)([^>]*)\swidth=["']\d+["']/gi, "<$1$2");
        content.innerHTML = safe;
        // Make all links open in new tab
        setTimeout(function(){
          var links = content.querySelectorAll("a");
          for(var i=0;i<links.length;i++){links[i].target="_blank";links[i].rel="noopener";}
        },0);
        shadow.appendChild(content);
      } else if (d.body) {
        var txt = el("div", {style:"font-size:0.82rem;color:#ccc;line-height:1.6;white-space:pre-line;"});
        txt.textContent = d.body;
        bodyWrap.appendChild(txt);
      }
      r.appendChild(bodyWrap);
    }

    render(d);
    return {el:r, update:function(nd){render(nd);}};
  };

  return {
    create:function(type,data){var f=_factories[type];return f?f(data):null;},
    has:function(type){return !!_factories[type];}
  };
})();
