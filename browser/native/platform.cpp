// Browser platform services for the OpenSpades gameplay core. GPL-3.0-or-later.
#include <Core/Debug.h>
#include <Core/Exception.h>
#include <Core/Stopwatch.h>
#include <emscripten.h>
#include <cstdarg>
#include <cstdio>
namespace spades {
namespace reflection {
BacktraceEntryAdder::BacktraceEntryAdder(const BacktraceEntry &) : bt(nullptr) {}
BacktraceEntryAdder::~BacktraceEntryAdder() {}
}
void LogMessage(const char *, int, const char *fmt, ...) {
  va_list args; va_start(args, fmt); vprintf(fmt,args); va_end(args); puts("");
}
Exception::Exception(const char *fmt, ...) {
  char b[2048]; va_list args; va_start(args,fmt); vsnprintf(b,sizeof(b),fmt,args); va_end(args);
  message=shortMessage=b;
}
Exception::Exception(const char *file, int line, const char *fmt, ...) {
  char b[2048]; va_list args; va_start(args,fmt); vsnprintf(b,sizeof(b),fmt,args); va_end(args);
  shortMessage=b; message=std::string(file)+":"+std::to_string(line)+": "+b;
}
Exception::~Exception() throw() {}
const char *Exception::what() const throw() { return message.c_str(); }
Stopwatch::Stopwatch() { Reset(); }
void Stopwatch::Reset() { start=emscripten_get_now(); }
double Stopwatch::GetTime() { return (emscripten_get_now()-start)/1000.; }
}
