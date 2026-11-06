/* Synthetic Windows sandbox probe. Never opens user data. */
#include <winsock2.h>
#include <windows.h>
#include <stdio.h>
#include <string.h>
int main(int argc, char **argv) {
  if (argc < 2) return 2;
  if (!strcmp(argv[1], "read") || !strcmp(argv[1], "write")) {
    if (argc < 3) return 2;
    FILE *file = fopen(argv[2], !strcmp(argv[1], "read") ? "rb" : "wb");
    if (file) { fclose(file); return 42; }
    return 0;
  }
  if (!strcmp(argv[1], "network")) {
    WSADATA wsa; if (WSAStartup(MAKEWORD(2,2), &wsa)) return 3;
    SOCKET sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (sock == INVALID_SOCKET) return WSAGetLastError() == WSAEACCES ? 0 : 4;
    struct sockaddr_in addr; memset(&addr,0,sizeof(addr));
    addr.sin_family=AF_INET; addr.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
    addr.sin_port=htons((unsigned short)atoi(argv[2]));
    unsigned long nonblocking=1; ioctlsocket(sock,FIONBIO,&nonblocking);
    int result=connect(sock,(struct sockaddr *)&addr,sizeof(addr));
    int error=WSAGetLastError();
    if(result == 0) { closesocket(sock); WSACleanup(); return 42; }
    if(error == WSAEWOULDBLOCK) {
      fd_set writes, errors; FD_ZERO(&writes); FD_ZERO(&errors); FD_SET(sock,&writes); FD_SET(sock,&errors);
      struct timeval deadline; deadline.tv_sec=1; deadline.tv_usec=0;
      int ready=select(0,NULL,&writes,&errors,&deadline);
      result = ready == 0 ? 0 : (FD_ISSET(sock,&writes) ? 42 : 0);
    } else result=error == WSAEACCES ? 0 : 4;
    closesocket(sock); WSACleanup(); return result;
  }
  if (!strcmp(argv[1], "child")) {
    STARTUPINFOA si; PROCESS_INFORMATION pi; memset(&si,0,sizeof(si)); si.cb=sizeof(si);
    char command[32768]; snprintf(command,sizeof(command),"\"%s\" sleep",argv[0]);
    if (!CreateProcessA(argv[0],command,NULL,NULL,FALSE,CREATE_NO_WINDOW,NULL,NULL,&si,&pi)) return 5;
    printf("%lu\n",pi.dwProcessId); fflush(stdout);
    CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
  }
  Sleep(60000); return 0;
}
