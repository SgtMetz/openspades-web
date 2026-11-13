#include <type_traits>
#include "curl/curl.h"
#include <emscripten/fetch.h>
#include <cstring>
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
  auto *request = emscripten_fetch(&attr,h->url.c_str());
  if (!request) return CURLE_FAILED_INIT;
  int result = CURLE_HTTP_RETURNED_ERROR;
  if (request->status >= 200 && request->status < 300 && h->write &&
      h->write(const_cast<char *>(request->data),1,request->numBytes,h->data) == request->numBytes) result = CURLE_OK;
  emscripten_fetch_close(request);
  return result;
}
