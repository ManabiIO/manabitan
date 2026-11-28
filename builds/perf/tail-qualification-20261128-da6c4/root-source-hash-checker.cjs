// Independent source-integrity checker used in V8 while the executor was unavailable.

function utf8(s) {
    const out=[];
    for (const c of s) {
        let p=c.codePointAt(0); if(p>=0xd800&&p<=0xdfff)p=0xfffd;
        if(p<128)out.push(p);
        else if(p<2048)out.push(192|(p>>>6),128|(p&63));
        else if(p<65536)out.push(224|(p>>>12),128|((p>>>6)&63),128|(p&63));
        else out.push(240|(p>>>18),128|((p>>>12)&63),128|((p>>>6)&63),128|(p&63));
    }
    return Uint8Array.from(out);
}
function padded(bytes) {
    const n=Math.ceil((bytes.length+9)/64)*64, out=new Uint8Array(n);
    out.set(bytes);out[bytes.length]=128;
    const view=new DataView(out.buffer),bits=bytes.length*8;
    view.setUint32(n-8,Math.floor(bits/4294967296));view.setUint32(n-4,bits>>>0);
    return view;
}
function hex(words){return Array.from(words,x=>(x>>>0).toString(16).padStart(8,"0")).join("");}
function sha256(bytes) {
    const h=Uint32Array.from([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    const k=Uint32Array.from([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
    const view=padded(bytes), w=new Uint32Array(64),ror=(x,n)=>(x>>>n)|(x<<(32-n));
    for(let p=0;p<view.byteLength;p+=64){
        for(let i=0;i<16;i++)w[i]=view.getUint32(p+i*4);
        for(let i=16;i<64;i++){
            const x=w[i-15],y=w[i-2];
            w[i]=(w[i-16]+(ror(x,7)^ror(x,18)^(x>>>3))+w[i-7]+(ror(y,17)^ror(y,19)^(y>>>10)))>>>0;
        }
        let [a,b,c,d,e,f,g,z]=h;
        for(let i=0;i<64;i++){
            const t1=(z+(ror(e,6)^ror(e,11)^ror(e,25))+((e&f)^(~e&g))+k[i]+w[i])>>>0;
            const t2=((ror(a,2)^ror(a,13)^ror(a,22))+((a&b)^(a&c)^(b&c)))>>>0;
            z=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
        }
        [a,b,c,d,e,f,g,z].forEach((x,i)=>{h[i]=(h[i]+x)>>>0;});
    }
    return hex(h);
}
function sha1(bytes) {
    const h=Uint32Array.from([0x67452301,0xefcdab89,0x98badcfe,0x10325476,0xc3d2e1f0]);
    const view=padded(bytes),w=new Uint32Array(80),rol=(x,n)=>(x<<n)|(x>>>(32-n));
    for(let p=0;p<view.byteLength;p+=64){
        for(let i=0;i<16;i++)w[i]=view.getUint32(p+i*4);
        for(let i=16;i<80;i++)w[i]=rol(w[i-3]^w[i-8]^w[i-14]^w[i-16],1)>>>0;
        let[a,b,c,d,e]=h;
        for(let i=0;i<80;i++){
            const f=i<20?(b&c)|(~b&d):i<40?b^c^d:i<60?(b&c)|(b&d)|(c&d):b^c^d;
            const k=i<20?0x5a827999:i<40?0x6ed9eba1:i<60?0x8f1bbcdc:0xca62c1d6;
            const t=(rol(a,5)+f+e+k+w[i])>>>0;e=d;d=c;c=rol(b,30)>>>0;b=a;a=t;
        }
        [a,b,c,d,e].forEach((x,i)=>{h[i]=(h[i]+x)>>>0;});
    }
    return hex(h);
}
function gitBlob(s){const b=utf8(s),prefix=utf8("blob "+b.length+"\u0000"),all=new Uint8Array(prefix.length+b.length);all.set(prefix);all.set(b,prefix.length);return sha1(all);}
module.exports = {utf8, sha256, sha1, gitBlob};
