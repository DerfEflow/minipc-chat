#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/capability.h>
#include <stdint.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef GUARD_PROGRAM_NAME
#error GUARD_PROGRAM_NAME is required
#endif
#ifndef GUARD_ENGINE_SHA256
#error GUARD_ENGINE_SHA256 is required
#endif
#ifndef GUARD_FILTER_SHA256
#error GUARD_FILTER_SHA256 is required
#endif

#define BROKER_UID 10003
#define ENGINE_FD 3
#define FILTER_FD 4
#define READY_FD 5
#define GO_FD 6
#define AT_EMPTY_PATH 0x1000

struct sha256_ctx { uint32_t h[8]; uint64_t bits; unsigned char block[64]; size_t used; };
static uint32_t rr(uint32_t v, unsigned n) { return (v >> n) | (v << (32U - n)); }
static const uint32_t sha_k[64] = {
  0x428a2f98U,0x71374491U,0xb5c0fbcfU,0xe9b5dba5U,0x3956c25bU,0x59f111f1U,0x923f82a4U,0xab1c5ed5U,
  0xd807aa98U,0x12835b01U,0x243185beU,0x550c7dc3U,0x72be5d74U,0x80deb1feU,0x9bdc06a7U,0xc19bf174U,
  0xe49b69c1U,0xefbe4786U,0x0fc19dc6U,0x240ca1ccU,0x2de92c6fU,0x4a7484aaU,0x5cb0a9dcU,0x76f988daU,
  0x983e5152U,0xa831c66dU,0xb00327c8U,0xbf597fc7U,0xc6e00bf3U,0xd5a79147U,0x06ca6351U,0x14292967U,
  0x27b70a85U,0x2e1b2138U,0x4d2c6dfcU,0x53380d13U,0x650a7354U,0x766a0abbU,0x81c2c92eU,0x92722c85U,
  0xa2bfe8a1U,0xa81a664bU,0xc24b8b70U,0xc76c51a3U,0xd192e819U,0xd6990624U,0xf40e3585U,0x106aa070U,
  0x19a4c116U,0x1e376c08U,0x2748774cU,0x34b0bcb5U,0x391c0cb3U,0x4ed8aa4aU,0x5b9cca4fU,0x682e6ff3U,
  0x748f82eeU,0x78a5636fU,0x84c87814U,0x8cc70208U,0x90befffaU,0xa4506cebU,0xbef9a3f7U,0xc67178f2U };
static void sha_block(struct sha256_ctx *c, const unsigned char *p) {
  uint32_t w[64];
  for (unsigned i=0;i<16;i++) w[i]=((uint32_t)p[i*4]<<24)|((uint32_t)p[i*4+1]<<16)|((uint32_t)p[i*4+2]<<8)|p[i*4+3];
  for (unsigned i=16;i<64;i++){uint32_t a=w[i-15],b=w[i-2];w[i]=w[i-16]+(rr(a,7)^rr(a,18)^(a>>3))+w[i-7]+(rr(b,17)^rr(b,19)^(b>>10));}
  uint32_t a=c->h[0],b=c->h[1],d=c->h[3],e=c->h[4],f=c->h[5],g=c->h[6],h=c->h[7],cc=c->h[2];
  for(unsigned i=0;i<64;i++){uint32_t s1=rr(e,6)^rr(e,11)^rr(e,25),ch=(e&f)^((~e)&g),t1=h+s1+ch+sha_k[i]+w[i];uint32_t s0=rr(a,2)^rr(a,13)^rr(a,22),maj=(a&b)^(a&cc)^(b&cc),t2=s0+maj;h=g;g=f;f=e;e=d+t1;d=cc;cc=b;b=a;a=t1+t2;}
  c->h[0]+=a;c->h[1]+=b;c->h[2]+=cc;c->h[3]+=d;c->h[4]+=e;c->h[5]+=f;c->h[6]+=g;c->h[7]+=h;
}
static void sha_init(struct sha256_ctx *c){static const uint32_t v[8]={0x6a09e667U,0xbb67ae85U,0x3c6ef372U,0xa54ff53aU,0x510e527fU,0x9b05688cU,0x1f83d9abU,0x5be0cd19U};memcpy(c->h,v,sizeof(v));c->bits=0;c->used=0;}
static void sha_update(struct sha256_ctx*c,const void*data,size_t n){const unsigned char*p=data;c->bits+=(uint64_t)n*8U;while(n){size_t take=64-c->used;if(take>n)take=n;memcpy(c->block+c->used,p,take);c->used+=take;p+=take;n-=take;if(c->used==64){sha_block(c,c->block);c->used=0;}}}
static void sha_final(struct sha256_ctx*c,unsigned char out[32]){c->block[c->used++]=0x80;if(c->used>56){while(c->used<64)c->block[c->used++]=0;sha_block(c,c->block);c->used=0;}while(c->used<56)c->block[c->used++]=0;for(int i=7;i>=0;i--)c->block[c->used++]=(unsigned char)(c->bits>>(i*8));sha_block(c,c->block);for(unsigned i=0;i<8;i++){out[i*4]=(unsigned char)(c->h[i]>>24);out[i*4+1]=(unsigned char)(c->h[i]>>16);out[i*4+2]=(unsigned char)(c->h[i]>>8);out[i*4+3]=(unsigned char)c->h[i];}}
static void sha_fd(int fd, char out[65]) {
  struct stat before, after;
  if (fstat(fd, &before) < 0 || !S_ISREG(before.st_mode) || before.st_uid != 0 || before.st_gid != 0
      || before.st_nlink != 1 || before.st_size <= 0 || before.st_size > 200000000) _exit(78);
  struct sha256_ctx context; sha_init(&context);
  unsigned char buffer[65536]; off_t offset = 0;
  while (offset < before.st_size) {
    ssize_t count = pread(fd, buffer, sizeof(buffer), offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) _exit(78);
    sha_update(&context, buffer, (size_t) count); offset += count;
  }
  unsigned char digest[32]; static const char hex[]="0123456789abcdef"; sha_final(&context,digest);
  for(unsigned i=0;i<32;i++){out[i*2]=hex[digest[i]>>4];out[i*2+1]=hex[digest[i]&15];}out[64]=0;
  if (fstat(fd,&after)<0||before.st_dev!=after.st_dev||before.st_ino!=after.st_ino
      ||before.st_size!=after.st_size||after.st_nlink!=1||after.st_uid!=0||after.st_gid!=0) _exit(78);
}
static int hex64(const char *value){if(!value||strlen(value)!=64)return 0;for(unsigned i=0;i<64;i++)if(!((value[i]>='0'&&value[i]<='9')||(value[i]>='a'&&value[i]<='f')))return 0;return 1;}
static void require_pipe(int fd){struct stat value;if(fstat(fd,&value)<0||!S_ISFIFO(value.st_mode))_exit(78);}
static void require_zero_caps(void) {
  struct __user_cap_header_struct header = { _LINUX_CAPABILITY_VERSION_3, 0 };
  struct __user_cap_data_struct data[2]; memset(data, 0, sizeof(data));
  if (syscall(SYS_capget, &header, data) < 0) _exit(78);
  for (unsigned i = 0; i < 2; i++) if (data[i].effective || data[i].permitted || data[i].inheritable) _exit(78);
}
static int write_all(int fd,const void*p,size_t n){const unsigned char*b=p;while(n){ssize_t k=write(fd,b,n);if(k<0&&errno==EINTR)continue;if(k<=0)return-1;b+=k;n-=(size_t)k;}return 0;}

int main(int argc, char **argv) {
  if (argc < 6 || strcmp(argv[1], "--generation") || strcmp(argv[3], "--nonce")
      || strcmp(argv[5], "--") || !hex64(argv[2]) || !hex64(argv[4])) _exit(78);
  if (getuid()!=BROKER_UID||geteuid()!=BROKER_UID||getgid()!=BROKER_UID||getegid()!=BROKER_UID
      || getppid()!=1 || prctl(PR_GET_NO_NEW_PRIVS,0,0,0,0)!=1 || prctl(PR_GET_SECCOMP,0,0,0,0)!=2) _exit(78);
  require_zero_caps(); require_pipe(READY_FD); require_pipe(GO_FD);
  struct stat engine, filter;
  if (fstat(ENGINE_FD,&engine)<0||!S_ISREG(engine.st_mode)||(engine.st_mode&07777)!=0555
      ||fstat(FILTER_FD,&filter)<0||!S_ISREG(filter.st_mode)||(filter.st_mode&07777)!=0444) _exit(78);
  char engine_hash[65], filter_hash[65]; sha_fd(ENGINE_FD,engine_hash); sha_fd(FILTER_FD,filter_hash);
  if (strcmp(engine_hash,GUARD_ENGINE_SHA256)||strcmp(filter_hash,GUARD_FILTER_SHA256)) _exit(78);
  unsigned char ready[8+32+32]; memcpy(ready,"DGFGRD01",8);
  for(unsigned part=0;part<2;part++){const char*s=part?argv[4]:argv[2];for(unsigned i=0;i<32;i++){unsigned hi=(unsigned)(s[i*2]<='9'?s[i*2]-'0':s[i*2]-'a'+10);unsigned lo=(unsigned)(s[i*2+1]<='9'?s[i*2+1]-'0':s[i*2+1]-'a'+10);ready[8+part*32+i]=(unsigned char)((hi<<4)|lo);}}
  if (write_all(READY_FD,ready,sizeof(ready))<0) _exit(78);
  char go=0; ssize_t count; do{count=read(GO_FD,&go,1);}while(count<0&&errno==EINTR);
  if(count!=1||go!='G'||getppid()!=1) _exit(78);
  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) < 0) _exit(78);
  if(close(FILTER_FD)<0||close(READY_FD)<0||close(GO_FD)<0) _exit(78);
  if (fcntl(ENGINE_FD, F_SETFD, FD_CLOEXEC) < 0) _exit(78);
  char **engine_argv=calloc((size_t)(argc-5)+1U,sizeof(char*)); if(!engine_argv)_exit(78);
  engine_argv[0]=(char*)GUARD_PROGRAM_NAME;
  for(int i=6;i<argc;i++)engine_argv[i-5]=argv[i];
  engine_argv[argc-5]=NULL;
  syscall(SYS_execveat,ENGINE_FD,"",engine_argv,environ,AT_EMPTY_PATH);
  _exit(78);
}
