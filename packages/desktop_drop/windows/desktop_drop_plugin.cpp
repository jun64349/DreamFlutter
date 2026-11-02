#include "include/desktop_drop/desktop_drop_plugin.h"

#include <windows.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <wincodec.h>

#include <flutter/method_channel.h>
#include <flutter/plugin_registrar_windows.h>
#include <flutter/standard_method_codec.h>

#include <memory>
#include <sstream>
#include <algorithm>

namespace {

    using FlutterMethodChannel = std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>>;


    using namespace std::literals::string_literals;

    std::string ws2s(const std::wstring &wstr) {
        if (wstr.empty()) {
            return {};
        }
        size_t pos;
        size_t begin = 0;
        std::string ret;

        int size;
        pos = wstr.find(static_cast<wchar_t>(0), begin);
        while (pos != std::wstring::npos && begin < wstr.length()) {
            std::wstring segment = std::wstring(&wstr[begin], pos - begin);
            size = WideCharToMultiByte(CP_UTF8,
                                       WC_ERR_INVALID_CHARS,
                                       &segment[0],
                                       (int) segment.size(),
                                       nullptr,
                                       0,
                                       nullptr,
                                       nullptr);
            std::string converted = std::string(size, 0);
            WideCharToMultiByte(CP_UTF8,
                                WC_ERR_INVALID_CHARS,
                                &segment[0],
                                (int) segment.size(),
                                &converted[0],
                                (int) converted.size(),
                                nullptr,
                                nullptr);
            ret.append(converted);
            ret.append({0});
            begin = pos + 1;
            pos = wstr.find(static_cast<wchar_t>(0), begin);
        }
        if (begin <= wstr.length()) {
            std::wstring segment = std::wstring(&wstr[begin], wstr.length() - begin);
            size =
                    WideCharToMultiByte(CP_UTF8,
                                        WC_ERR_INVALID_CHARS,
                                        &segment[0],
                                        (int) segment.size(),
                                        nullptr,
                                        0,
                                        nullptr,
                                        nullptr);
            std::string converted = std::string(size, 0);
            WideCharToMultiByte(CP_UTF8,
                                WC_ERR_INVALID_CHARS,
                                &segment[0],
                                (int) segment.size(),
                                &converted[0],
                                (int) converted.size(),
                                nullptr,
                                nullptr);
            ret.append(converted);
        }

        return ret;
    }


    class DesktopDropTarget : public IDropTarget {
    public:

        DesktopDropTarget(FlutterMethodChannel channel, HWND window_handle);

        HRESULT DragEnter(IDataObject *pDataObj, DWORD grfKeyState, POINTL pt, DWORD *pdwEffect) override;

        HRESULT DragOver(DWORD grfKeyState, POINTL pt, DWORD *pdwEffect) override;

        HRESULT DragLeave() override;

        HRESULT Drop(IDataObject *pDataObj, DWORD grfKeyState, POINTL pt, DWORD *pdwEffect) override;

        HRESULT QueryInterface(const IID &riid, void **ppvObject) override;

        ULONG AddRef() override;

        ULONG Release() override;

        virtual ~DesktopDropTarget();

    private:
        FlutterMethodChannel channel_;
        HWND window_handle_;
        LONG ref_count_;
        bool need_revoke_ole_initialize_;
    };

    class DesktopDropPlugin : public flutter::Plugin {

    public:
        static void RegisterWithRegistrar(flutter::PluginRegistrarWindows *registrar);

        explicit DesktopDropPlugin(DesktopDropTarget *target);

        ~DesktopDropPlugin() override;

    private:

        DesktopDropTarget *target_;

    };

    DesktopDropPlugin::DesktopDropPlugin(DesktopDropTarget *target) : target_(target) {
        target_->AddRef();
    }

    DesktopDropPlugin::~DesktopDropPlugin() {
        target_->Release();
    }


    // static
    void DesktopDropPlugin::RegisterWithRegistrar(
            flutter::PluginRegistrarWindows *registrar) {
        auto channel =
                std::make_unique<flutter::MethodChannel<flutter::EncodableValue>>(
                        registrar->messenger(), "desktop_drop",
                        &flutter::StandardMethodCodec::GetInstance());

        HWND hwnd = nullptr;
        if (registrar->GetView()) {
            hwnd = registrar->GetView()->GetNativeWindow();
        }

        if (hwnd == nullptr) {
            // no window, no drop.
            return;
        }

        channel->SetMethodCallHandler([](const auto &call, auto result) {
            result->NotImplemented();
        });

        auto drop_target = new DesktopDropTarget(std::move(channel), hwnd);

        auto plugin = std::make_unique<DesktopDropPlugin>(drop_target);

        registrar->AddPlugin(std::move(plugin));
    }


    DesktopDropTarget::DesktopDropTarget(FlutterMethodChannel channel, HWND window_handle) : channel_(
            std::move(channel)), window_handle_(window_handle), ref_count_(0), need_revoke_ole_initialize_(false) {
        auto ret = RegisterDragDrop(window_handle_, this);
        if (ret == E_OUTOFMEMORY) {
            OleInitialize(nullptr);
            ret = RegisterDragDrop(window_handle_, this);
            if (ret == 0) {
                need_revoke_ole_initialize_ = true;
            }
        }

        if (ret != 0) {
            std::cout << "RegisterDragDrop failed: " << ret << std::endl;
        }
    }

    HRESULT DesktopDropTarget::DragEnter(IDataObject *pDataObj, DWORD grfKeyState, POINTL pt, DWORD *pdwEffect) {
        POINT point = {pt.x, pt.y};
        ScreenToClient(window_handle_, &point);
        channel_->InvokeMethod("entered", std::make_unique<flutter::EncodableValue>(
                flutter::EncodableList{
                        flutter::EncodableValue(double(point.x)),
                        flutter::EncodableValue(double(point.y))
                }
        ));
        return 0;
    }

    HRESULT DesktopDropTarget::DragOver(DWORD grfKeyState, POINTL pt, DWORD *pdwEffect) {
        POINT point = {pt.x, pt.y};
        ScreenToClient(window_handle_, &point);
        channel_->InvokeMethod("updated", std::make_unique<flutter::EncodableValue>(
                flutter::EncodableList{
                        flutter::EncodableValue(double(point.x)),
                        flutter::EncodableValue(double(point.y))
                }
        ));
        return 0;
    }

    HRESULT DesktopDropTarget::DragLeave() {
        channel_->InvokeMethod("exited", std::make_unique<flutter::EncodableValue>());
        return 0;
    }

    // --- DreamFlutter: drops without file paths -----------------------------------
    //
    // Browsers and chat apps drag images out as virtual files (FileGroupDescriptorW +
    // FileContents) or as bitmaps (PNG, CF_DIBV5, CF_DIB) instead of CF_HDROP. These
    // are written to %TEMP%\DreamFlutter\drops\<n>\ and handed over as paths.

    std::wstring DropFolder() {
        wchar_t temp[MAX_PATH + 1];
        DWORD length = GetTempPathW(MAX_PATH + 1, temp);
        if (length == 0 || length > MAX_PATH) return {};
        std::wstring folder = std::wstring(temp) + L"DreamFlutter";
        CreateDirectoryW(folder.c_str(), nullptr);
        folder += L"\\drops";
        CreateDirectoryW(folder.c_str(), nullptr);
        static LONG counter = 0;
        folder += L"\\" + std::to_wstring(GetTickCount64()) + L"-" + std::to_wstring(InterlockedIncrement(&counter));
        if (!CreateDirectoryW(folder.c_str(), nullptr)) return {};
        return folder;
    }

    // A descriptor's name may carry folders or characters Windows rejects; keep the last part.
    std::wstring SafeName(std::wstring name, const wchar_t *fallback) {
        auto slash = name.find_last_of(L"\\/");
        if (slash != std::wstring::npos) name = name.substr(slash + 1);
        for (auto &c : name) {
            if (c < 32 || wcschr(L":*?\"<>|", c) != nullptr) c = L'_';
        }
        if (name.empty() || name == L"." || name == L"..") return fallback;
        return name;
    }

    bool WriteBytes(const std::wstring &path, const void *bytes, size_t size) {
        HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (file == INVALID_HANDLE_VALUE) return false;
        DWORD written = 0;
        bool ok = WriteFile(file, bytes, static_cast<DWORD>(size), &written, nullptr) && written == size;
        CloseHandle(file);
        if (!ok) DeleteFileW(path.c_str());
        return ok;
    }

    bool WriteStream(const std::wstring &path, IStream *stream) {
        HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (file == INVALID_HANDLE_VALUE) return false;
        LARGE_INTEGER zero = {};
        stream->Seek(zero, STREAM_SEEK_SET, nullptr);
        char buffer[64 * 1024];
        bool ok = true;
        for (;;) {
            ULONG read = 0;
            HRESULT hr = stream->Read(buffer, sizeof(buffer), &read);
            if (FAILED(hr)) { ok = false; break; }
            if (read == 0) break;
            DWORD written = 0;
            if (!WriteFile(file, buffer, read, &written, nullptr) || written != read) { ok = false; break; }
            if (hr == S_FALSE) break;
        }
        CloseHandle(file);
        if (!ok) DeleteFileW(path.c_str());
        return ok;
    }

    bool GetMedium(IDataObject *data, CLIPFORMAT format, LONG index, DWORD tymed, STGMEDIUM *medium) {
        FORMATETC fmt = {format, nullptr, DVASPECT_CONTENT, index, tymed};
        return data->GetData(&fmt, medium) == S_OK;
    }

    void AddPath(flutter::EncodableList &list, const std::wstring &path) {
        list.push_back(flutter::EncodableValue(ws2s(path)));
    }

    bool ReadVirtualFiles(IDataObject *data, flutter::EncodableList &list) {
        static const CLIPFORMAT descriptorFormat = static_cast<CLIPFORMAT>(RegisterClipboardFormatW(CFSTR_FILEDESCRIPTORW));
        static const CLIPFORMAT contentsFormat = static_cast<CLIPFORMAT>(RegisterClipboardFormatW(CFSTR_FILECONTENTS));
        STGMEDIUM descriptorMedium;
        if (!GetMedium(data, descriptorFormat, -1, TYMED_HGLOBAL, &descriptorMedium)) return false;
        auto group = static_cast<FILEGROUPDESCRIPTORW *>(GlobalLock(descriptorMedium.hGlobal));
        std::wstring folder;
        if (group != nullptr) {
            for (UINT i = 0; i < group->cItems; ++i) {
                const FILEDESCRIPTORW &descriptor = group->fgd[i];
                if ((descriptor.dwFlags & FD_ATTRIBUTES) && (descriptor.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) continue;
                if (folder.empty()) folder = DropFolder();
                if (folder.empty()) break;
                std::wstring path = folder + L"\\" + SafeName(descriptor.cFileName, (L"file-" + std::to_wstring(i)).c_str());
                STGMEDIUM content;
                if (!GetMedium(data, contentsFormat, static_cast<LONG>(i), TYMED_HGLOBAL | TYMED_ISTREAM, &content)) continue;
                bool ok = false;
                if (content.tymed == TYMED_ISTREAM && content.pstm != nullptr) {
                    ok = WriteStream(path, content.pstm);
                } else if (content.tymed == TYMED_HGLOBAL) {
                    void *bytes = GlobalLock(content.hGlobal);
                    if (bytes != nullptr) {
                        SIZE_T size = GlobalSize(content.hGlobal);
                        // FileContents in an HGLOBAL may be padded; the descriptor knows the real size.
                        if (descriptor.dwFlags & FD_FILESIZE) {
                            ULONGLONG real = (static_cast<ULONGLONG>(descriptor.nFileSizeHigh) << 32) | descriptor.nFileSizeLow;
                            if (real < size) size = static_cast<SIZE_T>(real);
                        }
                        ok = WriteBytes(path, bytes, size);
                        GlobalUnlock(content.hGlobal);
                    }
                }
                ReleaseStgMedium(&content);
                if (ok) AddPath(list, path);
            }
            GlobalUnlock(descriptorMedium.hGlobal);
        }
        ReleaseStgMedium(&descriptorMedium);
        return !list.empty();
    }

    // Encodes a bitmap file held in memory (BMP) as PNG through WIC.
    bool BmpToPng(const BYTE *bmp, size_t size, const std::wstring &path) {
        IWICImagingFactory *factory = nullptr;
        if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory)))) return false;
        bool ok = false;
        IStream *input = SHCreateMemStream(bmp, static_cast<UINT>(size));
        IWICBitmapDecoder *decoder = nullptr;
        IWICBitmapFrameDecode *frame = nullptr;
        IWICStream *output = nullptr;
        IWICBitmapEncoder *encoder = nullptr;
        IWICBitmapFrameEncode *target = nullptr;
        if (input != nullptr &&
            SUCCEEDED(factory->CreateDecoderFromStream(input, nullptr, WICDecodeMetadataCacheOnLoad, &decoder)) &&
            SUCCEEDED(decoder->GetFrame(0, &frame)) &&
            SUCCEEDED(factory->CreateStream(&output)) &&
            SUCCEEDED(output->InitializeFromFilename(path.c_str(), GENERIC_WRITE)) &&
            SUCCEEDED(factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, &encoder)) &&
            SUCCEEDED(encoder->Initialize(output, WICBitmapEncoderNoCache)) &&
            SUCCEEDED(encoder->CreateNewFrame(&target, nullptr)) &&
            SUCCEEDED(target->Initialize(nullptr)) &&
            SUCCEEDED(target->WriteSource(frame, nullptr)) &&
            SUCCEEDED(target->Commit()) &&
            SUCCEEDED(encoder->Commit())) {
            ok = true;
        }
        if (target) target->Release();
        if (encoder) encoder->Release();
        if (output) output->Release();
        if (frame) frame->Release();
        if (decoder) decoder->Release();
        if (input) input->Release();
        factory->Release();
        if (!ok) DeleteFileW(path.c_str());
        return ok;
    }

    bool ReadBitmap(IDataObject *data, flutter::EncodableList &list) {
        static const CLIPFORMAT pngFormat = static_cast<CLIPFORMAT>(RegisterClipboardFormatW(L"PNG"));
        STGMEDIUM medium;
        if (GetMedium(data, pngFormat, -1, TYMED_HGLOBAL, &medium)) {
            bool ok = false;
            std::wstring folder = DropFolder();
            void *bytes = GlobalLock(medium.hGlobal);
            if (bytes != nullptr && !folder.empty()) {
                std::wstring path = folder + L"\\image.png";
                ok = WriteBytes(path, bytes, GlobalSize(medium.hGlobal));
                if (ok) AddPath(list, path);
            }
            if (bytes != nullptr) GlobalUnlock(medium.hGlobal);
            ReleaseStgMedium(&medium);
            if (ok) return true;
        }
        for (CLIPFORMAT format : {static_cast<CLIPFORMAT>(CF_DIBV5), static_cast<CLIPFORMAT>(CF_DIB)}) {
            if (!GetMedium(data, format, -1, TYMED_HGLOBAL, &medium)) continue;
            bool ok = false;
            auto dib = static_cast<const BYTE *>(GlobalLock(medium.hGlobal));
            SIZE_T size = GlobalSize(medium.hGlobal);
            std::wstring folder = dib != nullptr ? DropFolder() : std::wstring();
            if (dib != nullptr && size >= sizeof(BITMAPINFOHEADER) && !folder.empty()) {
                auto header = reinterpret_cast<const BITMAPINFOHEADER *>(dib);
                // A BMP file is the DIB behind a file header that says where the pixels start.
                DWORD colors = header->biClrUsed != 0 ? header->biClrUsed : (header->biBitCount <= 8 ? (1u << header->biBitCount) : 0);
                DWORD masks = (header->biSize == sizeof(BITMAPINFOHEADER) && header->biCompression == BI_BITFIELDS) ? 3 * sizeof(DWORD) : 0;
                BITMAPFILEHEADER file = {};
                file.bfType = 0x4D42;
                file.bfSize = static_cast<DWORD>(sizeof(file) + size);
                file.bfOffBits = static_cast<DWORD>(sizeof(file) + header->biSize + masks + colors * sizeof(RGBQUAD));
                std::string bmp(reinterpret_cast<const char *>(&file), sizeof(file));
                bmp.append(reinterpret_cast<const char *>(dib), size);
                std::wstring path = folder + L"\\image.png";
                ok = BmpToPng(reinterpret_cast<const BYTE *>(bmp.data()), bmp.size(), path);
                if (ok) AddPath(list, path);
            }
            if (dib != nullptr) GlobalUnlock(medium.hGlobal);
            ReleaseStgMedium(&medium);
            if (ok) return true;
        }
        return false;
    }

    HRESULT DesktopDropTarget::Drop(IDataObject *pDataObj, DWORD grfKeyState, POINTL pt, DWORD *pdwEffect) {

        flutter::EncodableList list = {};

        // construct a FORMATETC object
        FORMATETC fmtetc = {CF_HDROP, nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL};
        STGMEDIUM stgmed;

        // See if the dataobject contains any TEXT stored as a HGLOBAL
        if (pDataObj->QueryGetData(&fmtetc) == S_OK) {
            // Yippie! the data is there, so go get it!
            if (pDataObj->GetData(&fmtetc, &stgmed) == S_OK) {
                // we asked for the data as a HGLOBAL, so access it appropriately
                PVOID data = GlobalLock(stgmed.hGlobal);
                if (data != nullptr) {
                    auto files = DragQueryFileW(reinterpret_cast<HDROP>(data), 0xFFFFFFFF, nullptr, 0);
                    for (unsigned int i = 0; i < files; ++i) {
                        // DreamFlutter: no MAX_PATH limit (long paths were cut off).
                        UINT length = DragQueryFileW(reinterpret_cast<HDROP>(data), i, nullptr, 0);
                        std::wstring wide(length + 1, L'\0');
                        DragQueryFileW(reinterpret_cast<HDROP>(data), i, &wide[0], length + 1);
                        wide.resize(length);
                        list.push_back(flutter::EncodableValue(ws2s(wide)));
                    }
                    GlobalUnlock(stgmed.hGlobal);
                }

                // release the data using the COM API
                ReleaseStgMedium(&stgmed);
            }
        }
        // DreamFlutter: no paths -> try virtual files, then a bitmap. An empty list still
        // reaches Dart, which tells the user the content could not be read.
        if (list.empty() && !ReadVirtualFiles(pDataObj, list)) ReadBitmap(pDataObj, list);
        if (pdwEffect != nullptr) *pdwEffect = list.empty() ? DROPEFFECT_NONE : DROPEFFECT_COPY;
        channel_->InvokeMethod("performOperation", std::make_unique<flutter::EncodableValue>(list));

        return 0;
    }

    HRESULT DesktopDropTarget::QueryInterface(const IID &iid, void **ppvObject) {
        if (iid == IID_IDropTarget || iid == IID_IUnknown) {
            AddRef();
            *ppvObject = this;
            return S_OK;
        } else {
            *ppvObject = nullptr;
            return E_NOINTERFACE;
        }
    }

    ULONG DesktopDropTarget::AddRef() {
        return InterlockedIncrement(&ref_count_);
    }

    ULONG DesktopDropTarget::Release() {
        LONG count = InterlockedDecrement(&ref_count_);

        if (count == 0) {
            delete this;
            return 0;
        } else {
            return count;
        }
    }

    DesktopDropTarget::~DesktopDropTarget() {
        RevokeDragDrop(window_handle_);
        if (need_revoke_ole_initialize_) {
            OleUninitialize();
        }
    }

}  // namespace

void DesktopDropPluginRegisterWithRegistrar(
        FlutterDesktopPluginRegistrarRef registrar) {
    DesktopDropPlugin::RegisterWithRegistrar(
            flutter::PluginRegistrarManager::GetInstance()
                    ->GetRegistrar<flutter::PluginRegistrarWindows>(registrar));

}
