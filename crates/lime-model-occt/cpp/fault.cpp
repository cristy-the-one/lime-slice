// A hardware fault inside Open CASCADE refuses the step instead of ending the app. This file is Lime Slice (MIT).
// It calls the LGPL library; the notice is third_party/occt/NOTICE.md.
//
// On Windows a structured exception translator throws the fault as a Standard_Failure for the length of one bridge
// call. Elsewhere Open CASCADE's own signal jumps do it (OCC_CATCH_SIGNALS), with handlers that act only while one of
// those is on the faulting thread's stack, since OSD::SetSignal would also take Ctrl-C, hang-up, and Rust's stack
// overflow check for the whole app.
//
// A fault on one of Open CASCADE's worker threads (OSD_Parallel, a parallel boolean) never meets this translator,
// which is per thread: OSD_ThreadPool::performJob catches it with `catch (...)` (Open CASCADE is built /EHa) and
// raises it again on the calling thread as "Error: Unknown exception", which set_failure in tree.cpp words as ours.

#include "kernel.h"

#include <cstdio>

#include <Message.hxx>
#include <Standard_Failure.hxx>
#include <TCollection_AsciiString.hxx>

#if defined(_MSC_VER)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <eh.h>
#else
#include <signal.h>

#include <cstddef>
#include <cstring>
#include <mutex>
#endif

namespace lime_occt {

const char* const kInternalError = "The modeler hit an internal error on this step; the step was not applied.";

}  // namespace lime_occt

#if defined(_MSC_VER)

namespace {

/// The faults a step can raise and still leave the process able to go on: not a stack overflow, a breakpoint, or a
/// C++ exception, which keep their own handling.
bool refusable(unsigned code) {
    switch (code) {
        case EXCEPTION_ACCESS_VIOLATION:
        case EXCEPTION_IN_PAGE_ERROR:
        case EXCEPTION_ILLEGAL_INSTRUCTION:
        case EXCEPTION_PRIV_INSTRUCTION:
        case EXCEPTION_INT_DIVIDE_BY_ZERO:
        case EXCEPTION_INT_OVERFLOW:
        case EXCEPTION_ARRAY_BOUNDS_EXCEEDED:
        case EXCEPTION_DATATYPE_MISALIGNMENT:
        case EXCEPTION_FLT_DIVIDE_BY_ZERO:
        case EXCEPTION_FLT_INVALID_OPERATION:
        case EXCEPTION_FLT_OVERFLOW:
        case EXCEPTION_FLT_UNDERFLOW:
        case EXCEPTION_FLT_INEXACT_RESULT:
        case EXCEPTION_FLT_DENORMAL_OPERAND:
        case EXCEPTION_FLT_STACK_CHECK:
            return true;
        default:
            return false;
    }
}

/// `TKBRep.dll+0x1c208`: the module and offset a crash report needs, without a dump.
void write_where(char* out, size_t size, const void* address) {
    HMODULE module = nullptr;
    char path[MAX_PATH] = "";
    if (address != nullptr &&
        GetModuleHandleExA(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            static_cast<LPCSTR>(address),
            &module) &&
        GetModuleFileNameA(module, path, MAX_PATH) > 0) {
        const char* name = path;
        for (const char* at = path; *at != '\0'; ++at) {
            if (*at == '\\' || *at == '/') {
                name = at + 1;
            }
        }
        std::snprintf(
            out,
            size,
            "%s+0x%llx",
            name,
            static_cast<unsigned long long>(static_cast<const char*>(address) - reinterpret_cast<const char*>(module)));
        return;
    }
    std::snprintf(out, size, "%p", address);
}

void translate(unsigned code, EXCEPTION_POINTERS* info) {
    if (!refusable(code)) {
        return;
    }
    const void* address = info != nullptr && info->ExceptionRecord != nullptr ? info->ExceptionRecord->ExceptionAddress : nullptr;
    char where[MAX_PATH + 32];
    write_where(where, sizeof where, address);
    char line[MAX_PATH + 160];
    std::snprintf(line, sizeof line, "Lime Slice: fault 0x%08x at %s inside Open CASCADE; the step was refused.", code, where);
    lime_occt::route_occt_log();
    Message::SendFail(TCollection_AsciiString(line));
    throw Standard_Failure(lime_occt::kInternalError);
}

}  // namespace

namespace lime_occt {

FaultScope::FaultScope() : previous_(reinterpret_cast<void*>(_set_se_translator(translate))) {}

FaultScope::~FaultScope() { _set_se_translator(reinterpret_cast<_se_translator_function>(previous_)); }

}  // namespace lime_occt

#else

namespace {

constexpr int kSignals[] = {SIGSEGV, SIGBUS, SIGILL, SIGFPE};
struct sigaction g_before[sizeof kSignals / sizeof kSignals[0]];
/// Set while this thread turns a fault into a jump: a second fault in that (an allocation on a broken heap) crashes.
thread_local bool t_jumping = false;

/// The jump skips the destructors between the fault and the nearest OCC_CATCH_SIGNALS, as Open CASCADE's own handler
/// does: what those frames held leaks, and a lock one of them held would stay held. A refused step is still better
/// than a closed app, and every later call starts from the solids the tree already holds.
void on_fault(int signal, siginfo_t* info, void* context) {
    if (!t_jumping && Standard_ErrorHandler::IsInTryBlock()) {
        t_jumping = true;
        sigset_t unblock;
        sigemptyset(&unblock);
        sigaddset(&unblock, signal);
        pthread_sigmask(SIG_UNBLOCK, &unblock, nullptr);
        const Handle(Standard_Failure) failure = Standard_Failure::NewInstance(lime_occt::kInternalError);
        t_jumping = false;
        // Jumps to the nearest OCC_CATCH_SIGNALS, which throws this as a C++ exception from there.
        failure->Jump();
    }
    for (size_t i = 0; i < sizeof kSignals / sizeof kSignals[0]; ++i) {
        if (kSignals[i] != signal) {
            continue;
        }
        const struct sigaction& before = g_before[i];
        if ((before.sa_flags & SA_SIGINFO) != 0 && before.sa_sigaction != nullptr) {
            before.sa_sigaction(signal, info, context);
            return;
        }
        if (before.sa_handler != SIG_DFL && before.sa_handler != SIG_IGN && before.sa_handler != nullptr) {
            before.sa_handler(signal);
            return;
        }
        // Default: put it back and return, so the instruction faults again and the process ends as it would have.
        struct sigaction fallback;
        std::memset(&fallback, 0, sizeof fallback);
        fallback.sa_handler = SIG_DFL;
        sigemptyset(&fallback.sa_mask);
        sigaction(signal, &fallback, nullptr);
        return;
    }
}

}  // namespace

namespace lime_occt {

void watch_faults() {
    static std::once_flag once;
    std::call_once(once, [] {
        for (size_t i = 0; i < sizeof kSignals / sizeof kSignals[0]; ++i) {
            struct sigaction action;
            std::memset(&action, 0, sizeof action);
            action.sa_sigaction = on_fault;
            // On the alternate stack Rust gives each thread, so a stack overflow still reaches Rust's handler.
            action.sa_flags = SA_SIGINFO | SA_ONSTACK;
            sigemptyset(&action.sa_mask);
            sigaction(kSignals[i], &action, &g_before[i]);
        }
    });
}

}  // namespace lime_occt

#endif
