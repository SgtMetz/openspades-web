#include <type_traits>
#include "curl/curl.h"
#include <emscripten/fetch.h>
#include <cstring>
#include <cstdlib>
#include <string>
#include <emscripten/threading.h>
// The hosting page may send a request elsewhere (browser.js osRewriteUrl: its own server list in place of the
// master server's). Asked on the main thread, which owns the page and its settings.
static std::string rewriteUrl(const std::string &url) {
  char *out = (char *)MAIN_THREAD_EM_ASM_PTR({
    var u = UTF8ToString($0);
    var r = Module['osRewriteUrl'] ? Module['osRewriteUrl'](u) : u;
    return stringToNewUTF8(r || u);
  }, url.c_str());
  if (!out) return url;
  std::string r(out);
  std::free(out);
  return r;
}
CURL *curl_easy_init() { return new CURL; }
void curl_easy_cleanup(CURL *h) { delete h; }
const char *curl_easy_strerror(CURLcode) { return "Browser HTTP request failed"; }
extern bool browserVerification;
CURLcode curl_easy_perform(CURL *h) {
  if (browserVerification) { if (h->write) h->write(const_cast<char *>("[]"),1,2,h->data); return CURLE_OK; }
  emscripten_fetch_attr_t attr;
  emscripten_fetch_attr_init(&attr);
  std::strcpy(attr.requestMethod, "GET");
  attr.attributes = EMSCRIPTEN_FETCH_LOAD_TO_MEMORY | EMSCRIPTEN_FETCH_SYNCHRONOUS;
  attr.timeoutMSecs = 30000;
  const std::string url = rewriteUrl(h->url);
  auto *request = emscripten_fetch(&attr,url.c_str());
  if (!request) return CURLE_FAILED_INIT;
  int result = CURLE_HTTP_RETURNED_ERROR;
  if (request->status >= 200 && request->status < 300 && h->write &&
      h->write(const_cast<char *>(request->data),1,request->numBytes,h->data) == request->numBytes) result = CURLE_OK;
  emscripten_fetch_close(request);
  return result;
}
