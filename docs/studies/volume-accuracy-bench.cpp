// Measures volume_of, volume_about and BRepGProp::VolumeProperties on breps written by
// volume-accuracy-shapes.ts. volume_of / volume_about / faces_volume / integrated_volume are the
// kernel functions (crates/lime-model-occt/cpp/kernel.cpp) with the g_stats counter lines left
// out; those lines only count the call. This file is not linked into the app.
//
// Build (Open CASCADE 7.9.2, the CI install, headers in $OCCT_ROOT/include/opencascade):
//
//   g++ -std=c++17 -O2 -o /tmp/volume-accuracy-bench docs/studies/volume-accuracy-bench.cpp \
//     -I"$OCCT_ROOT/include/opencascade" \
//     -L"$OCCT_ROOT/lib" -Wl,-rpath,"$OCCT_ROOT/lib" \
//     -lTKTopAlgo -lTKBRep -lTKGeomAlgo -lTKGeomBase -lTKG3d -lTKG2d -lTKMath -lTKernel \
//     -lpthread -ldl
//
//   /tmp/volume-accuracy-bench /tmp/volume-accuracy/*.brep

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <functional>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include <BRepGProp.hxx>
#include <BRepGProp_Domain.hxx>
#include <BRepGProp_Face.hxx>
#include <BRepGProp_Vinert.hxx>
#include <BRep_Tool.hxx>
#include <BinTools.hxx>
#include <GProp_GProps.hxx>
#include <OSD_Parallel.hxx>
#include <TopAbs_Orientation.hxx>
#include <TopAbs_ShapeEnum.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Shape.hxx>
#include <Standard_Failure.hxx>
#include <gp_Pnt.hxx>

namespace {

struct MemoryBuffer : std::streambuf {
    MemoryBuffer(char* data, size_t size) { setg(data, data, data + size); }

    pos_type seekoff(off_type offset, std::ios_base::seekdir dir, std::ios_base::openmode) override {
        char* base = dir == std::ios_base::beg ? eback() : dir == std::ios_base::cur ? gptr() : egptr();
        if (offset < eback() - base || offset > egptr() - base) {
            return pos_type(off_type(-1));
        }
        char* to = base + offset;
        setg(eback(), to, egptr());
        return pos_type(to - eback());
    }

    pos_type seekpos(pos_type pos, std::ios_base::openmode mode) override {
        return seekoff(off_type(pos), std::ios_base::beg, mode);
    }
};

double faces_volume(const std::vector<TopoDS_Face>& faces, const gp_Pnt& about) {
    std::vector<double> parts(faces.size(), 0.0);
    OSD_Parallel::For(0, static_cast<int>(faces.size()), [&faces, &parts, &about](int i) {
        const TopoDS_Face& face = faces[static_cast<size_t>(i)];
        const TopAbs_Orientation orientation = face.Orientation();
        if (orientation != TopAbs_FORWARD && orientation != TopAbs_REVERSED) {
            return;
        }
        BRepGProp_Face surface;
        BRepGProp_Vinert inertia;
        inertia.SetLocation(about);
        surface.Load(face);
        if (face.NbChildren() == 0) {
            inertia.Perform(surface);
        } else {
            BRepGProp_Domain domain;
            domain.Init(face);
            inertia.Perform(surface, domain);
        }
        parts[static_cast<size_t>(i)] = inertia.Mass();
    });
    double total = 0.0;
    for (const double part : parts) {
        total = total + part;
    }
    return total;
}

double volume_of(const TopoDS_Shape& shape);

double integrated_volume(const TopoDS_Shape& shape) {
    gp_XYZ middle(0, 0, 0);
    int vertices = 0;
    for (TopExp_Explorer explorer(shape, TopAbs_VERTEX); explorer.More(); explorer.Next()) {
        middle += BRep_Tool::Pnt(TopoDS::Vertex(explorer.Current())).XYZ();
        vertices += 1;
    }
    std::vector<TopoDS_Face> faces;
    bool plain = vertices > 0;
    for (TopExp_Explorer explorer(shape, TopAbs_FACE); explorer.More() && plain; explorer.Next()) {
        const TopoDS_Face& face = TopoDS::Face(explorer.Current());
        TopLoc_Location location;
        plain = !BRep_Tool::Surface(face, location).IsNull();
        faces.push_back(face);
    }
    if (!plain) {
        GProp_GProps props;
        BRepGProp::VolumeProperties(shape, props);
        return props.Mass();
    }
    middle /= vertices;
    return faces_volume(faces, gp_Pnt(middle));
}

double volume_of(const TopoDS_Shape& shape) {
    if (shape.IsNull()) {
        return 0;
    }
    if (shape.ShapeType() == TopAbs_COMPOUND || shape.ShapeType() == TopAbs_COMPSOLID) {
        double total = 0;
        int count = 0;
        for (TopExp_Explorer explorer(shape, TopAbs_SOLID); explorer.More(); explorer.Next()) {
            total += integrated_volume(explorer.Current());
            count += 1;
        }
        if (count > 0) {
            return total;
        }
    }
    return integrated_volume(shape);
}

double volume_about(const TopoDS_Shape& shape, const gp_Pnt& about) {
    if (shape.IsNull()) {
        return 0;
    }
    std::vector<TopoDS_Face> faces;
    for (TopExp_Explorer explorer(shape, TopAbs_FACE); explorer.More(); explorer.Next()) {
        const TopoDS_Face& face = TopoDS::Face(explorer.Current());
        TopLoc_Location location;
        if (BRep_Tool::Surface(face, location).IsNull()) {
            return volume_of(shape);
        }
        faces.push_back(face);
    }
    return faces_volume(faces, about);
}

gp_Pnt vertex_mean(const TopoDS_Shape& shape, int& vertices) {
    gp_XYZ middle(0, 0, 0);
    vertices = 0;
    for (TopExp_Explorer explorer(shape, TopAbs_VERTEX); explorer.More(); explorer.Next()) {
        middle += BRep_Tool::Pnt(TopoDS::Vertex(explorer.Current())).XYZ();
        vertices += 1;
    }
    if (vertices > 0) {
        middle /= vertices;
    }
    return gp_Pnt(middle);
}

int count_of(const TopoDS_Shape& shape, TopAbs_ShapeEnum kind) {
    int count = 0;
    for (TopExp_Explorer explorer(shape, kind); explorer.More(); explorer.Next()) {
        count += 1;
    }
    return count;
}

int trimmed_faces(const TopoDS_Shape& shape) {
    int count = 0;
    for (TopExp_Explorer explorer(shape, TopAbs_FACE); explorer.More(); explorer.Next()) {
        if (TopoDS::Face(explorer.Current()).NbChildren() > 0) {
            count += 1;
        }
    }
    return count;
}

struct Sample {
    double value = 0;
    double returned = -1;
    bool has_returned = false;
    bool ok = false;
    std::string error;
    std::vector<double> times_ms;
};

double median_of(std::vector<double> values) {
    if (values.empty()) {
        return 0;
    }
    std::sort(values.begin(), values.end());
    return values[values.size() / 2];
}

double mean_of(const std::vector<double>& values) {
    double total = 0;
    for (const double value : values) {
        total += value;
    }
    return values.empty() ? 0 : total / static_cast<double>(values.size());
}

constexpr int kWarmup = 1;
constexpr int kRepeats = 5;

template <class F>
Sample time_calls(F&& call) {
    Sample sample;
    for (int i = 0; i < kWarmup; ++i) {
        std::string error;
        double value = 0;
        double returned = -1;
        bool has_returned = false;
        if (!call(value, returned, has_returned, error)) {
            sample.error = error.empty() ? "call failed" : error;
            return sample;
        }
    }
    for (int i = 0; i < kRepeats; ++i) {
        std::string error;
        double value = 0;
        double returned = -1;
        bool has_returned = false;
        const auto start = std::chrono::steady_clock::now();
        const bool ok = call(value, returned, has_returned, error);
        const auto stop = std::chrono::steady_clock::now();
        if (!ok) {
            sample.error = error.empty() ? "call failed" : error;
            sample.times_ms.clear();
            return sample;
        }
        if (i > 0 && value != sample.value) {
            sample.error = "value changed between repeats";
        }
        sample.value = value;
        sample.returned = returned;
        sample.has_returned = has_returned;
        sample.times_ms.push_back(std::chrono::duration<double, std::milli>(stop - start).count());
    }
    sample.ok = sample.error.empty();
    return sample;
}

Sample time_value(const std::function<double()>& fn) {
    return time_calls([&](double& value, double&, bool&, std::string& error) {
        try {
            value = fn();
            if (!std::isfinite(value)) {
                error = "non-finite";
                return false;
            }
            return true;
        } catch (const Standard_Failure& failure) {
            error = failure.GetMessageString() == nullptr ? "Standard_Failure" : failure.GetMessageString();
            return false;
        } catch (const std::exception& failure) {
            error = failure.what();
            return false;
        } catch (...) {
            error = "unknown exception";
            return false;
        }
    });
}

Sample time_eps(const TopoDS_Shape& shape, double eps) {
    return time_calls([&](double& value, double& returned, bool& has_returned, std::string& error) {
        try {
            GProp_GProps props;
            returned = BRepGProp::VolumeProperties(shape, props, eps);
            has_returned = true;
            value = props.Mass();
            if (!std::isfinite(value)) {
                error = "non-finite";
                return false;
            }
            return true;
        } catch (const Standard_Failure& failure) {
            error = failure.GetMessageString() == nullptr ? "Standard_Failure" : failure.GetMessageString();
            return false;
        } catch (const std::exception& failure) {
            error = failure.what();
            return false;
        } catch (...) {
            error = "unknown exception";
            return false;
        }
    });
}

struct Method {
    std::string name;
    bool candidate = false;
    Sample sample;
};

std::string join_times(const std::vector<double>& times) {
    std::ostringstream out;
    out.setf(std::ios::fixed);
    out << std::setprecision(4);
    for (size_t i = 0; i < times.size(); ++i) {
        if (i > 0) {
            out << ",";
        }
        out << times[i];
    }
    return out.str();
}

void print_num(std::ostream& out, double value) {
    std::ostringstream text;
    text.setf(std::ios::fmtflags(0), std::ios::floatfield);
    text << std::setprecision(17) << value;
    out << text.str();
}

bool load_brep(const std::string& path, TopoDS_Shape& shape, std::string& header, std::string& error) {
    std::ifstream in(path, std::ios::binary);
    if (!in) {
        error = "could not open " + path;
        return false;
    }
    std::ostringstream buffer;
    buffer << in.rdbuf();
    std::string bytes = buffer.str();
    const auto newline = bytes.find('\n');
    if (newline == std::string::npos || bytes.compare(0, 9, "LIMEBREP ") != 0) {
        error = "not a LIMEBREP file: " + path;
        return false;
    }
    header = bytes.substr(0, newline);
    std::string body = bytes.substr(newline + 1);
    const std::string marker = "\nLIMEORDER ";
    const auto order = body.rfind(marker);
    if (order != std::string::npos) {
        body.resize(order);
    }
    MemoryBuffer streambuf(body.data(), body.size());
    std::istream stream(&streambuf);
    BinTools::Read(shape, stream);
    if (shape.IsNull() || stream.fail()) {
        error = "BinTools could not read " + path;
        return false;
    }
    return true;
}

double header_volume(const std::string& header) {
    std::istringstream in(header);
    std::string magic;
    std::string format;
    std::string version;
    double volume = std::nan("");
    in >> magic >> format >> version >> volume;
    return volume;
}

std::string stem_of(const std::string& path) {
    const auto slash = path.find_last_of('/');
    std::string name = slash == std::string::npos ? path : path.substr(slash + 1);
    const auto dot = name.rfind('.');
    if (dot != std::string::npos) {
        name.resize(dot);
    }
    return name;
}

}  // namespace

int main(int argc, char** argv) {
    std::cout.imbue(std::locale::classic());
    if (argc < 2) {
        std::cerr << "usage: volume-accuracy-bench file.brep ...\n";
        return 2;
    }
    const double cylinder = 12.5 * 12.5 * 40.0 * std::acos(-1.0);
    std::cout << "BENCH repeats=" << kRepeats << " warmup=" << kWarmup
              << " threads=" << std::thread::hardware_concurrency()
              << " cylinder_analytic_mm3=";
    print_num(std::cout, cylinder);
    std::cout << " formula=pi*12.5^2*40 bar=max(abs(ref)*1e-4, 0.01 mm3)\n";

    struct ShapeRow {
        std::string name;
        double reference = 0;
        std::string reference_kind;
        bool settled = false;
        std::vector<Method> methods;
    };
    std::vector<ShapeRow> shapes;

    for (int arg = 1; arg < argc; ++arg) {
        const std::string path = argv[arg];
        const std::string name = stem_of(path);
        TopoDS_Shape shape;
        std::string header;
        std::string error;
        if (!load_brep(path, shape, header, error)) {
            std::cerr << "FAIL " << error << "\n";
            return 1;
        }
        const int vertices_n = count_of(shape, TopAbs_VERTEX);
        int mean_vertices = 0;
        const gp_Pnt mean = vertex_mean(shape, mean_vertices);
        const double stored = header_volume(header);
        std::cout << "SHAPE name=" << name << " faces=" << count_of(shape, TopAbs_FACE)
                  << " trimmed=" << trimmed_faces(shape) << " solids=" << count_of(shape, TopAbs_SOLID)
                  << " shells=" << count_of(shape, TopAbs_SHELL) << " vertices=" << vertices_n
                  << " header=" << header << " header_volume_mm3=";
        print_num(std::cout, stored);
        std::cout << " vertex_mean_mm=";
        print_num(std::cout, mean.X());
        std::cout << ",";
        print_num(std::cout, mean.Y());
        std::cout << ",";
        print_num(std::cout, mean.Z());
        std::cout << "\n";

        ShapeRow row;
        row.name = name;
        const auto add = [&](const std::string& method, bool candidate, Sample sample) {
            row.methods.push_back(Method{method, candidate, std::move(sample)});
        };
        add("volume_of", true, time_value([&] { return volume_of(shape); }));
        add("volume_about", true, time_value([&] { return volume_about(shape, mean); }));
        add("volume_about_origin", false, time_value([&] { return volume_about(shape, gp_Pnt(0, 0, 0)); }));
        add("VolumeProperties", false, time_value([&] {
                GProp_GProps props;
                BRepGProp::VolumeProperties(shape, props);
                return props.Mass();
            }));
        // Gauss-Kronrod, not one of the settings under test: a second OCCT algorithm, to see whether
        // the adaptive Gauss values have settled. IsUseSpan is on, which matters for B-spline faces.
        for (const double eps : {1e-6, 1e-8}) {
            std::ostringstream label;
            label.setf(std::ios::fmtflags(0), std::ios::floatfield);
            label << std::setprecision(1) << std::scientific << "VolumePropertiesGK span eps=" << eps;
            add(label.str(), false, time_calls([&](double& value, double& returned, bool& has_returned, std::string& error) {
                    try {
                        GProp_GProps props;
                        returned = BRepGProp::VolumePropertiesGK(shape, props, eps, Standard_False, Standard_True);
                        has_returned = true;
                        value = props.Mass();
                        if (!std::isfinite(value) || returned < 0.0) {
                            error = returned < 0.0 ? "GK failed" : "non-finite";
                            return false;
                        }
                        return true;
                    } catch (const Standard_Failure& failure) {
                        error = failure.GetMessageString() == nullptr ? "Standard_Failure" : failure.GetMessageString();
                        return false;
                    } catch (const std::exception& failure) {
                        error = failure.what();
                        return false;
                    } catch (...) {
                        error = "unknown exception";
                        return false;
                    }
                }));
        }
        for (const double eps : {1e-3, 1e-4, 1e-5, 1e-6, 1e-7, 1e-8, 1e-9, 1e-10, 1e-11, 1e-12}) {
            std::ostringstream label;
            label.setf(std::ios::fmtflags(0), std::ios::floatfield);
            label << std::setprecision(1) << std::scientific << "VolumeProperties eps=" << eps;
            add(label.str(), true, time_eps(shape, eps));
        }

        std::vector<const Method*> eps_rows;
        for (const Method& method : row.methods) {
            if (method.name.rfind("VolumeProperties eps=", 0) == 0) {
                eps_rows.push_back(&method);
            }
        }
        const Method* tightest = nullptr;
        const Method* previous = nullptr;
        for (const Method* method : eps_rows) {
            if (!method->sample.ok) {
                continue;
            }
            previous = tightest;
            tightest = method;
        }
        if (name == "cylinder") {
            row.reference = cylinder;
            row.reference_kind = "analytic pi*12.5^2*40";
            row.settled = true;
        } else if (tightest != nullptr && previous != nullptr) {
            // Settled when the two tightest successful eps agree well inside the study bar
            // (1e-6 relative, or 0.0001 mm3). The reference is then the tighter of the two.
            const double gap = std::abs(tightest->sample.value - previous->sample.value);
            const double tol = std::max(std::abs(tightest->sample.value) * 1.0e-6, 1.0e-4);
            row.reference = tightest->sample.value;
            row.settled = gap <= tol;
            row.reference_kind = tightest->name + (row.settled ? " settled" : " NOT settled");
            std::cout << "SETTLE name=" << name << " tighter=" << tightest->name << " looser=" << previous->name
                      << " gap_mm3=";
            print_num(std::cout, gap);
            std::cout << " tol_mm3=";
            print_num(std::cout, tol);
            std::cout << " settled=" << (row.settled ? 1 : 0) << "\n";
        } else if (tightest != nullptr) {
            row.reference = tightest->sample.value;
            row.reference_kind = tightest->name + " NOT settled";
        } else {
            row.reference_kind = "missing";
        }
        std::cout << "REF name=" << name << " kind=" << row.reference_kind << " settled=" << (row.settled ? 1 : 0)
                  << " value_mm3=";
        print_num(std::cout, row.reference);
        std::cout << "\n";
        for (size_t i = 1; i < eps_rows.size(); ++i) {
            std::cout << "GAP name=" << name << " " << eps_rows[i - 1]->name << " minus " << eps_rows[i]->name << " mm3=";
            if (!eps_rows[i - 1]->sample.ok || !eps_rows[i]->sample.ok) {
                std::cout << "na\n";
            } else {
                print_num(std::cout, eps_rows[i - 1]->sample.value - eps_rows[i]->sample.value);
                std::cout << "\n";
            }
        }
        const double bar = std::max(std::abs(row.reference) * 1.0e-4, 0.01);
        for (const Method& method : row.methods) {
            std::cout << "ROW name=" << name << " method=" << method.name << " candidate=" << (method.candidate ? 1 : 0);
            if (!method.sample.ok) {
                std::cout << " ok=0 error=" << method.sample.error << "\n";
                continue;
            }
            const double abs_err = std::abs(method.sample.value - row.reference);
            const double rel_pct = row.reference == 0.0 ? std::nan("") : 100.0 * abs_err / std::abs(row.reference);
            const bool pass = std::isfinite(rel_pct) && abs_err <= bar;
            std::cout << " ok=1 value_mm3=";
            print_num(std::cout, method.sample.value);
            std::cout << " abs_mm3=";
            print_num(std::cout, abs_err);
            std::cout << " rel_pct=";
            print_num(std::cout, rel_pct);
            std::cout << " bar_mm3=";
            print_num(std::cout, bar);
            std::cout << " pass=" << (pass ? 1 : 0) << " median_ms=" << std::fixed << std::setprecision(4)
                      << median_of(method.sample.times_ms) << " mean_ms=" << mean_of(method.sample.times_ms)
                      << " times_ms=" << join_times(method.sample.times_ms);
            std::cout.unsetf(std::ios::floatfield);
            if (method.sample.has_returned) {
                std::cout << " returned_error=";
                print_num(std::cout, method.sample.returned);
            }
            std::cout << "\n";
        }

        const Method* quick = nullptr;
        for (const Method& method : row.methods) {
            if (method.name == "volume_of") {
                quick = &method;
            }
        }
        std::cout << "HEADER_DELTA name=" << name << " volume_of_minus_header_mm3=";
        if (quick != nullptr && quick->sample.ok && std::isfinite(stored)) {
            print_num(std::cout, quick->sample.value - stored);
        } else {
            std::cout << "na";
        }
        std::cout << "\n";
        shapes.push_back(std::move(row));
    }

    if (shapes.empty()) {
        return 1;
    }
    bool all_settled = true;
    for (const ShapeRow& shape : shapes) {
        if (!shape.settled) {
            all_settled = false;
        }
        std::cout << "REF_OK name=" << shape.name << " settled=" << (shape.settled ? 1 : 0) << "\n";
    }
    std::cout << "SUGGESTION bar=abs_err<=max(abs(ref)*1e-4, 0.01) cost=sum of median_ms references_settled="
              << (all_settled ? 1 : 0) << "\n";
    std::vector<std::string> names;
    for (const Method& method : shapes.front().methods) {
        if (method.candidate) {
            names.push_back(method.name);
        }
    }
    const Method* best = nullptr;
    double best_cost = 0;
    std::string best_name;
    for (const std::string& name : names) {
        bool all_ok = true;
        bool all_pass = true;
        double cost = 0;
        for (const ShapeRow& shape : shapes) {
            const Method* method = nullptr;
            for (const Method& one : shape.methods) {
                if (one.name == name) {
                    method = &one;
                }
            }
            if (method == nullptr || !method->sample.ok) {
                all_ok = false;
                all_pass = false;
                break;
            }
            const double bar = std::max(std::abs(shape.reference) * 1.0e-4, 0.01);
            const double abs_err = std::abs(method->sample.value - shape.reference);
            if (!(abs_err <= bar)) {
                all_pass = false;
            }
            cost += median_of(method->sample.times_ms);
        }
        std::cout << "CANDIDATE method=" << name << " all_measured=" << (all_ok ? 1 : 0)
                  << " all_pass=" << (all_pass ? 1 : 0) << " sum_median_ms=" << std::fixed << std::setprecision(4)
                  << cost << "\n";
        std::cout.unsetf(std::ios::floatfield);
        if (all_ok && all_pass && (best == nullptr || cost < best_cost)) {
            best_cost = cost;
            best_name = name;
            best = &shapes.front().methods.front();
        }
    }
    (void)best;
    if (best_name.empty()) {
        std::cout << "SUGGESTED none\n";
    } else {
        std::cout << "SUGGESTED method=" << best_name << " sum_median_ms=" << std::fixed << std::setprecision(4)
                  << best_cost << " provisional=" << (all_settled ? 0 : 1) << "\n";
    }
    return 0;
}
